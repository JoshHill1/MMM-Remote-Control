/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */
/*
 * Layout preview for the MMM-Remote-Control edit menu.
 *
 * Self-contained: listens for the "mmrc-modules-loaded" CustomEvent that
 * loadVisibleModules() dispatches after populating #visible-modules-results,
 * then builds a draggable wireframe of the mirror layout above the list.
 *
 * Saving routes through RC's existing config-write path (NEW_CONFIG socket
 * notification -> node_helper saveConfigWithBackup), which makes its own
 * rotating backup of config.js before writing. Changes apply on the next
 * MagicMirror restart.
 */
(() => {
  "use strict";

  /*
   * Loaded both via <script> in remote.html and via import from
   * remote-modules.mjs (node_helper caches remote.html at startup, so the
   * import path works without restarting the mirror). Run only once.
   */
  if (globalThis.LayoutPreview) {
    return;
  }

  // Self-inject the stylesheet in case remote.html doesn't reference it yet
  if (!document.querySelector("link[href*=\"layout-preview.css\"]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "modules/MMM-Remote-Control/layout-preview.css";
    document.head.append(link);
  }

  const GRID_REGIONS = [
    "top_bar",
    "top_left",
    "top_center",
    "top_right",
    "upper_third",
    "middle_center",
    "lower_third",
    "bottom_left",
    "bottom_center",
    "bottom_right",
    "bottom_bar"
  ];

  // Valid MagicMirror positions that don't map to a grid cell (rendered as an extra tray row when in use)
  const EXTRA_REGIONS = ["fullscreen_above", "fullscreen_below"];

  const DRAG_THRESHOLD_PX = 6;

  const COLORS_STORAGE_KEY = "mmrc_lp_colors";

  function loadColorOverrides () {
    try {
      const parsed = JSON.parse(localStorage.getItem(COLORS_STORAGE_KEY) ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  const state = {
    modules: [], // [{identifier, name, label, position, hidden, header}]
    byIdentifier: new Map(),
    baseline: null, // {region: [identifier, ...]} as currently configured
    arrangement: null, // {region: [identifier, ...]} pending (drag-edited)
    dirty: false,
    remote: null, // Remote object, handed over by the loadVisibleModules hook
    saving: false,
    colorOverrides: loadColorOverrides(), // module label -> "#rrggbb"
    defaultHues: null // Map(label -> hue), collision-free per module set
  };

  /* ---------- colors ---------- */

  function hueForName (name) {
    let hash = 0;
    for (const char of String(name)) {
      hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    }

    /*
     * Knuth multiplicative scramble: labels differing by one character
     * ("weather 1" vs "weather 2") must still land on far-apart hues.
     */
    return (Math.imul(hash, 2_654_435_761) >>> 0) % 360;
  }

  function hslToHex (h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
  }

  function hueDistance (a, b) {
    return Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  }

  /**
   * Assigns every label a hue kept apart from all others, so no two modules
   * ever look the same color. Each label keeps its hash hue unless it lands
   * within MIN_HUE_GAP of an already-taken one — then it gets the hue
   * farthest from everything taken so far. Deterministic per label set.
   */
  function assignDefaultHues (modules) {
    const MIN_HUE_GAP = 24;
    const labels = [...new Set(modules.map((module) => module.label))].toSorted(compareByName);
    const taken = [];
    const hues = new Map();
    for (const label of labels) {
      let hue = hueForName(label);
      if (taken.some((t) => hueDistance(t, hue) < MIN_HUE_GAP)) {
        let best = hue,
          bestGap = -1;
        for (let candidate = 0; candidate < 360; candidate += 1) {
          const gap = Math.min(...taken.map((t) => hueDistance(t, candidate)));
          if (gap > bestGap) {
            bestGap = gap;
            best = candidate;
          }
        }
        hue = best;
      }
      taken.push(hue);
      hues.set(label, hue);
    }
    return hues;
  }

  // Hex so the value can seed an <input type="color"> directly
  function colorForName (name) {
    const hue = state.defaultHues?.get(name) ?? hueForName(name);
    return state.colorOverrides[name] ?? hslToHex(hue, 65, 55);
  }

  function colorBgFor (hex) {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.16)`;
  }

  /* ---------- layout state ---------- */

  function buildBaseline (modules) {
    const layout = {};
    for (const module of modules) {
      (layout[module.position] ??= []).push(module.identifier);
    }
    return layout;
  }

  function cloneLayout (layout) {
    const copy = {};
    for (const [region, ids] of Object.entries(layout)) {
      copy[region] = [...ids];
    }
    return copy;
  }

  function compareByName (left, right) {
    return left.localeCompare(right);
  }

  function layoutsEqual (a, b) {
    const regionsA = Object.keys(a).toSorted(compareByName);
    const regionsB = Object.keys(b).toSorted(compareByName);
    if (regionsA.length !== regionsB.length) {
      return false;
    }
    return regionsA.every((region, index) => region === regionsB[index] &&
      a[region].length === b[region].length &&
      a[region].every((id, position) => id === b[region][position]));
  }

  /**
   * Re-applies a pending arrangement onto a freshly loaded baseline:
   * keeps drag edits for modules that still exist, places newly appeared
   * modules in their configured region.
   */
  function reconcile (baseline, pending) {
    const liveIds = new Set(Object.values(baseline).flat());
    const placed = new Set();
    const next = {};
    for (const [region, ids] of Object.entries(pending)) {
      const kept = ids.filter((id) => liveIds.has(id));
      for (const id of kept) {
        placed.add(id);
      }
      if (kept.length > 0) {
        next[region] = kept;
      }
    }
    for (const [region, ids] of Object.entries(baseline)) {
      for (const id of ids) {
        if (!placed.has(id)) {
          (next[region] ??= []).push(id);
        }
      }
    }
    return next;
  }

  function updateDirty () {
    state.dirty = !layoutsEqual(state.baseline, state.arrangement);
    const root = document.querySelector("#layout-preview");
    root?.classList.toggle("lp-dirty", state.dirty);
  }

  function readArrangementFromDom (root) {
    const layout = {};
    for (const cell of root.querySelectorAll(".lp-cell")) {
      const ids = [...cell.querySelectorAll(".lp-block")].map((block) => block.dataset.identifier);
      if (ids.length > 0) {
        layout[cell.dataset.region] = ids;
      }
    }
    return layout;
  }

  /* ---------- rendering ---------- */

  function formatRegion (region) {
    return region.replaceAll("_", " ");
  }

  function createBlock (module) {
    const block = document.createElement("div");
    block.className = "lp-block";
    if (module.hidden) {
      block.classList.add("lp-hidden");
    }
    block.dataset.identifier = module.identifier;
    const color = colorForName(module.label);
    block.style.setProperty("--lp-color", color);
    block.style.setProperty("--lp-color-bg", colorBgFor(color));
    block.textContent = module.label;
    block.title = module.header
      ? `${module.label} (${module.header})`
      : module.label;
    block.addEventListener("pointerdown", onPointerDown);
    return block;
  }

  function createCell (region) {
    const cell = document.createElement("div");
    cell.className = "lp-cell";
    cell.dataset.region = region;
    const label = document.createElement("span");
    label.className = "lp-cell-label";
    label.textContent = formatRegion(region);
    cell.append(label);
    const identifiers = state.arrangement[region] ?? [];
    for (const id of identifiers) {
      const module = state.byIdentifier.get(id);
      if (module) {
        cell.append(createBlock(module));
      }
    }
    return cell;
  }

  function render () {
    const anchor = document.querySelector("#visible-modules-container");
    if (!anchor) {
      return;
    }

    let root = document.querySelector("#layout-preview");
    if (!root) {
      root = document.createElement("div");
      root.id = "layout-preview";
      anchor.parentNode.insertBefore(root, anchor);
    }
    root.replaceChildren();

    const header = document.createElement("div");
    header.className = "lp-header";
    const title = document.createElement("span");
    title.className = "lp-title";
    title.textContent = "Layout preview";
    const badge = document.createElement("span");
    badge.className = "lp-badge";
    badge.textContent = "Unsaved changes";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "lp-save";
    save.textContent = state.saving ? "Saving…" : "Save layout";
    save.disabled = state.saving;
    save.addEventListener("click", saveLayout);
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "lp-reset";
    reset.textContent = "Reset";
    reset.disabled = state.saving;
    reset.addEventListener("click", () => {
      state.arrangement = cloneLayout(state.baseline);
      updateDirty();
      render();
    });
    header.append(title, badge, save, reset);
    root.append(header);

    const screen = document.createElement("div");
    screen.className = "lp-screen";
    for (const region of GRID_REGIONS) {
      screen.append(createCell(region));
    }
    root.append(screen);

    // Fullscreen/other positions only get a tray row when actually used
    const extrasInUse = EXTRA_REGIONS.filter((region) => (state.arrangement[region] ?? []).length > 0);
    if (extrasInUse.length > 0) {
      const extra = document.createElement("div");
      extra.className = "lp-extra";
      for (const region of extrasInUse) {
        extra.append(createCell(region));
      }
      root.append(extra);
    }

    updateDirty();
  }

  /**
   * Adds a color swatch to each module's row in #visible-modules-results so
   * the list and the preview read as linked. Clicking a swatch opens a color
   * picker; the choice is stored per module name in localStorage.
   */
  function decorateList () {
    for (const module of state.modules) {
      const item = document.getElementById(module.identifier);
      if (!item) {
        continue;
      }
      let swatch = item.querySelector(".lp-swatch");
      if (!swatch) {
        swatch = document.createElement("span");
        swatch.className = "lp-swatch";
        swatch.title = "Change color";

        /*
         * Far end of the row, away from the show/hide toggle: the picker
         * overlay must never sit between the toggle icon and the label
         * where it would swallow hide/show taps.
         */
        item.append(swatch);
        attachColorPicker(swatch, module.label);
      }
      const color = colorForName(module.label);
      swatch.style.backgroundColor = color;
      const input = swatch.querySelector(".lp-color-input");
      if (input) {
        input.value = color;
      }
    }
  }

  function stopClickPropagation (event) {
    event.stopPropagation();
  }

  /**
   * Wires an <input type="color"> to a list swatch. The input is an
   * invisible overlay on the dot (slightly larger tap target) and receives
   * the tap directly — iOS Safari won't open the picker from a programmatic
   * click() on a hidden input. stopPropagation keeps the tap from toggling
   * the module row's show/hide handler.
   */
  function attachColorPicker (swatch, moduleLabel) {
    const input = document.createElement("input");
    input.type = "color";
    input.className = "lp-color-input";
    input.setAttribute("aria-label", `Color for ${moduleLabel}`);
    input.value = colorForName(moduleLabel);
    swatch.append(input);

    input.addEventListener("click", stopClickPropagation);
    swatch.addEventListener("click", stopClickPropagation);

    // iOS fires "change" on confirm; desktop browsers fire "input" live
    const apply = () => {
      state.colorOverrides[moduleLabel] = input.value;
      localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(state.colorOverrides));
      render();
      decorateList();
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
  }

  /* ---------- drag and drop (pointer events, works for mouse + touch) ---------- */

  let drag = null;

  function onPointerDown (event) {
    if (event.button !== 0 && event.pointerType === "mouse") {
      return;
    }
    const block = event.currentTarget;
    drag = {
      block,
      "pointerId": event.pointerId,
      "startX": event.clientX,
      "startY": event.clientY,
      "active": false,
      "ghost": null,
      "lastCell": null
    };

    /*
     * Listen on document (not the block): the block is reparented between
     * cells mid-drag, and some browsers drop pointer capture on DOM moves.
     */
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerEnd);
  }

  function startDrag (event) {
    const {block} = drag;
    const rect = block.getBoundingClientRect();
    drag.offsetX = event.clientX - rect.left;
    drag.offsetY = event.clientY - rect.top;
    const ghost = block.cloneNode(true);
    ghost.classList.add("lp-ghost");
    ghost.style.width = `${rect.width}px`;
    document.body.append(ghost);
    drag.ghost = ghost;
    block.classList.add("lp-dragging");
    drag.active = true;
  }

  function cellAt (x, y) {
    for (const element of document.elementsFromPoint(x, y)) {
      const cell = element.closest?.(".lp-cell");
      if (cell) {
        return cell;
      }
    }
    return null;
  }

  function onPointerMove (event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag.active) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < DRAG_THRESHOLD_PX) {
        return;
      }
      startDrag(event);
    }
    event.preventDefault();

    drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
    drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;

    const cell = cellAt(event.clientX, event.clientY);
    if (drag.lastCell && drag.lastCell !== cell) {
      drag.lastCell.classList.remove("lp-drop-target");
    }
    if (!cell) {
      drag.lastCell = null;
      return;
    }
    cell.classList.add("lp-drop-target");
    drag.lastCell = cell;

    // Live-snap the real block into the would-be drop slot
    const siblings = [...cell.querySelectorAll(".lp-block")].filter((b) => b !== drag.block);
    const before = siblings.find((sibling) => {
      const rect = sibling.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    if (before) {
      before.before(drag.block);
    } else {
      cell.append(drag.block);
    }
  }

  function onPointerEnd (event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const {block, ghost, lastCell, active} = drag;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerEnd);
    document.removeEventListener("pointercancel", onPointerEnd);
    ghost?.remove();
    lastCell?.classList.remove("lp-drop-target");
    block.classList.remove("lp-dragging");
    drag = null;

    if (active) {
      const root = document.querySelector("#layout-preview");
      if (root) {
        state.arrangement = readArrangementFromDom(root);
        updateDirty();
      }
    }
  }

  /* ---------- saving (routes through RC's NEW_CONFIG config-write path) ---------- */

  // All positions MagicMirror's loader accepts, in preview display order
  const VALID_POSITIONS = [...GRID_REGIONS, ...EXTRA_REGIONS];

  /**
   * Maps live module identifiers to config.modules array indices.
   * Mirrors MagicMirror's js/loader.js getAllModules(): the identifier index
   * enumerates entries with a defined module name and a valid or undefined
   * position — disabled entries still consume an index.
   */
  function buildIdentifierMap (configModules) {
    const map = new Map();
    let loaderIndex = 0;
    for (const [configIndex, entry] of configModules.entries()) {
      const hasValidPosition = entry.position === undefined || VALID_POSITIONS.includes(entry.position);
      if (entry.module !== undefined && hasValidPosition) {
        map.set(`module_${loaderIndex}_${entry.module}`, configIndex);
        loaderIndex += 1;
      }
    }
    return map;
  }

  function normalizeHeader (header) {
    return header ?? "";
  }

  /*
   * config.modules entries may use a path like "custom/MMM-Foo"; live module
   * names are always the basename
   */
  function moduleBasename (moduleField) {
    return String(moduleField).split("/").at(-1);
  }

  /**
   * Matches preview modules to config.modules entries and returns a
   * Map(identifier -> config array index).
   *
   * Fast path: MagicMirror's loader enumeration (the index embedded in the
   * identifier), verified by name + header. That enumeration goes stale as
   * soon as a save reorders config.modules while the mirror (or this page)
   * still runs with the old order — so unmatched modules fall back to
   * matching by module name + header, which survive reordering. Same-name
   * same-header twins are paired in stable order.
   */
  function matchModulesToConfig (configModules, previewModules) {
    const matched = new Map();
    const claimed = new Set();

    const enumerationMap = buildIdentifierMap(configModules);
    for (const module of previewModules) {
      const configIndex = enumerationMap.get(module.identifier);
      if (configIndex === undefined || claimed.has(configIndex)) {
        continue;
      }
      const entry = configModules[configIndex];
      if (moduleBasename(entry.module) === module.name &&
        normalizeHeader(entry.header) === normalizeHeader(module.header)) {
        matched.set(module.identifier, configIndex);
        claimed.add(configIndex);
      }
    }

    for (const module of previewModules) {
      if (matched.has(module.identifier)) {
        continue;
      }
      const candidate = configModules.findIndex((entry, index) => !claimed.has(index) &&
        entry.module !== undefined &&
        moduleBasename(entry.module) === module.name &&
        normalizeHeader(entry.header) === normalizeHeader(module.header));
      if (candidate === -1) {
        const label = module.header ? `${module.name} (${module.header})` : module.name;
        throw new Error(`Could not find a config.js entry for ${label}. Reload this page and try again — nothing was saved.`);
      }
      matched.set(module.identifier, candidate);
      claimed.add(candidate);
    }

    return matched;
  }

  /**
   * Applies the pending arrangement to a freshly fetched config object:
   * sets each managed module's position and permutes the managed entries of
   * config.modules so within-region array order matches the stack order
   * (MagicMirror stacks modules in a region by modules-array order).
   * Unmanaged entries (disabled, position-less) keep their slots untouched.
   */
  function applyArrangement (config) {
    const configModules = config.modules;
    const matched = matchModulesToConfig(configModules, state.modules);
    const regionRank = new Map(VALID_POSITIONS.map((region, index) => [region, index]));

    const managed = [];
    for (const [region, ids] of Object.entries(state.arrangement)) {
      for (const [rank, identifier] of ids.entries()) {
        const configIndex = matched.get(identifier);
        if (configIndex === undefined) {
          throw new Error(`Could not match "${identifier}" to a config.js entry. Reload this page and try again — nothing was saved.`);
        }
        managed.push({configIndex, region, rank});
      }
    }

    for (const {configIndex, region} of managed) {
      configModules[configIndex].position = region;
    }

    const slots = managed.map((m) => m.configIndex).toSorted((a, b) => a - b);
    const ordered = managed.toSorted((a, b) => regionRank.get(a.region) - regionRank.get(b.region) || a.rank - b.rank);
    const entries = ordered.map((m) => configModules[m.configIndex]);
    for (const [index, slot] of slots.entries()) {
      configModules[slot] = entries[index];
    }
    return config;
  }

  /**
   * Intercepts Remote.handleSaveConfig for saves initiated here, so the
   * settings-menu machinery (offerReload + loadConfigModules) doesn't run
   * against the edit menu's DOM. Other saves pass through untouched.
   */
  function patchSaveHandler (remote) {
    if (remote.lpSavePatched) {
      return;
    }
    remote.lpSavePatched = true;
    const original = remote.handleSaveConfig;
    remote.handleSaveConfig = (result) => {
      if (!state.saving) {
        original.call(remote, result);
        return;
      }
      state.saving = false;
      remote.saving = false;
      if (result.success) {
        state.baseline = cloneLayout(state.arrangement);
        updateDirty();
        render();
        offerRestartOnce(remote);
      } else {
        render();
        remote.setStatus("error", "Saving the layout failed — config.js was not changed.");
      }
    };
  }

  /**
   * Post-save prompt with a one-click restart (unlike the stock restart
   * button, which opens a second confirmation dialog).
   */
  function offerRestartOnce (remote) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = "<span>Layout saved to config.js. Restart MagicMirror to apply it.</span>";
    const restart = remote.createSymbolText(
      "fa fa-fw fa-recycle",
      remote.translate("RESTARTMM") ?? "Restart MagicMirror",
      () => {
        remote.action("RESTART");
        remote.setStatus("none");
      }
    );
    wrapper.append(restart);
    const later = remote.createSymbolText(
      "fa fa-fw fa-times",
      remote.translate("CANCEL") ?? "Later",
      () => {
        remote.setStatus("none");
      }
    );
    wrapper.append(later);
    remote.setStatus("success", false, wrapper);
  }

  async function saveLayout () {
    const remote = state.remote;
    if (!state.dirty || state.saving || !remote || remote.saving) {
      return;
    }
    state.saving = true;
    remote.saving = true;
    render();
    try {
      // Same endpoint the settings menu uses: full parsed config from disk
      const response = await fetch("get?data=config");
      const parsed = JSON.parse(await response.text());
      if (!parsed.success || !Array.isArray(parsed.data?.modules)) {
        throw new Error("Fetching the current config failed. Nothing was saved.");
      }
      const config = applyArrangement(parsed.data);
      // handleSaveConfig (patched above) picks up the async result
      remote.sendSocketNotification("NEW_CONFIG", config);
    } catch (error) {
      state.saving = false;
      remote.saving = false;
      render();
      remote.setStatus("error", error.message);
    }
  }

  /* ---------- entry point ---------- */

  function ingest (moduleData) {
    const positioned = moduleData.filter((module) => module.position);
    state.modules = positioned.map((module) => ({
      "identifier": module.identifier,
      "name": module.name,
      "label": module.name,
      "position": module.position,
      "hidden": Boolean(module.hidden),
      "header": module.header
    }));

    /*
     * Same module twice (e.g. two weather instances)? Number them so each
     * gets its own label — and with it, its own color.
     */
    const nameCounts = new Map();
    for (const module of state.modules) {
      nameCounts.set(module.name, (nameCounts.get(module.name) ?? 0) + 1);
    }
    const numbered = new Map();
    for (const module of state.modules) {
      if (nameCounts.get(module.name) < 2) {
        continue;
      }

      const n = (numbered.get(module.name) ?? 0) + 1;
      numbered.set(module.name, n);
      module.label = `${module.name} ${n}`;
    }
    state.defaultHues = assignDefaultHues(state.modules);
    state.byIdentifier = new Map(state.modules.map((module) => [module.identifier, module]));
    state.baseline = buildBaseline(state.modules);
    // Keep unsaved drag edits across menu re-entries within this page load
    state.arrangement = state.dirty && state.arrangement
      ? reconcile(state.baseline, state.arrangement)
      : cloneLayout(state.baseline);
    render();
    decorateList();
  }

  document.addEventListener("mmrc-modules-loaded", (event) => {
    if (event.detail?.remote) {
      state.remote = event.detail.remote;
      patchSaveHandler(state.remote);
    }
    ingest(event.detail?.modules ?? []);
  });

  // Exposed for debugging from the console
  // eslint-disable-next-line unicorn/no-global-object-property-assignment
  globalThis.LayoutPreview = {
    "getLayout": () => cloneLayout(state.arrangement ?? {}),
    "getBaseline": () => cloneLayout(state.baseline ?? {}),
    "isDirty": () => state.dirty,
    "save": saveLayout,
    "reset": () => {
      if (!state.baseline) {
        return;
      }
      state.arrangement = cloneLayout(state.baseline);
      updateDirty();
      render();
    }
  };
})();

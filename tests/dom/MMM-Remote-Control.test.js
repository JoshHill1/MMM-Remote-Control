const {test, describe, before, after} = require("node:test");
const assert = require("node:assert/strict");
const {Window} = require("happy-dom");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

describe("MMM-Remote-Control.js module", () => {
  let window, Module;

  before(() => {
    window = new Window({
      url: "http://localhost:8080",
      settings: {
        disableJavaScriptFileLoading: true,
        disableJavaScriptEvaluation: false,
        disableCSSFileLoading: true
      }
    });

    window.Module = {
      register: function (moduleName, moduleDefinition) {
        Module = moduleDefinition;
      }
    };

    window.MM = {
      getModules: () => ({
        enumerate: () => {}
      })
    };

    window.Log = {
      info: () => {},
      log: () => {},
      error: () => {},
      warn: () => {}
    };

    window.location = {hash: ""};
    window.globalThis = window;

    const modulePath = path.join(__dirname, "../../MMM-Remote-Control.js");
    const moduleCode = fs.readFileSync(modulePath, "utf8");
    const context = vm.createContext(window);
    vm.runInContext(moduleCode, context);
  });

  after(() => {
    window.close();
  });

  test("module is registered with Module.register", () => {
    assert.ok(Module, "Module should be defined");
    assert.ok(Module.handleDefaultSettings, "handleDefaultSettings should exist");
  });

  test("handleDefaultSettings handles missing lockStrings gracefully", () => {
    const payload = {
      settingsVersion: 1,
      moduleData: [
        {identifier: "module_1", name: "clock"},
        {identifier: "module_2", name: "calendar", lockStrings: ["lock1"]},
        {identifier: "module_3", name: "weather", lockStrings: undefined}
      ],
      brightness: 100,
      temp: 327,
      zoom: 100,
      backgroundColor: "",
      fontColor: ""
    };

    assert.doesNotThrow(() => {
      Module.handleDefaultSettings.call({
        identifier: "MMM-Remote-Control",
        settingsVersion: 1,
        setBrightness: () => {},
        setTemp: () => {},
        setZoom: () => {},
        setBackgroundColor: () => {},
        setFontColor: () => {}
      }, payload);
    });
  });

  test("handleDefaultSettings handles non-array lockStrings", () => {
    const payload = {
      settingsVersion: 1,
      moduleData: [{identifier: "module_1", name: "clock", lockStrings: "not-an-array"}],
      brightness: 100,
      temp: 327,
      zoom: 100,
      backgroundColor: "",
      fontColor: ""
    };

    assert.doesNotThrow(() => {
      Module.handleDefaultSettings.call({
        identifier: "MMM-Remote-Control",
        settingsVersion: 1,
        setBrightness: () => {},
        setTemp: () => {},
        setZoom: () => {},
        setBackgroundColor: () => {},
        setFontColor: () => {}
      }, payload);
    });
  });

  test("hiding a module re-shows a visible sibling stuck at position:fixed", () => {
    const shown = [];
    const makeModule = (identifier, position, hidden) => ({
      identifier,
      name: identifier,
      data: {position},
      hidden,
      lockStrings: [],
      hide (speed, callback) { callback(); },
      show () { shown.push(identifier); }
    });

    const target = makeModule("module_1_pix", "bottom_left", false);
    const stuckSibling = makeModule("module_2_qr", "bottom_left", false);
    const hiddenSibling = makeModule("module_3_news", "bottom_left", true);
    const otherRegion = makeModule("module_4_clock", "top_left", false);
    const allModules = [target, stuckSibling, hiddenSibling, otherRegion];

    for (const module of allModules) {
      const wrapper = window.document.createElement("div");
      wrapper.id = module.identifier;
      window.document.body.append(wrapper);
    }

    /*
     * The stuck sibling reports visible but its wrapper is out of static flow;
     * the hidden sibling is legitimately hidden and must stay that way.
     */
    window.document.getElementById(stuckSibling.identifier).style.position = "fixed";
    window.document.getElementById(hiddenSibling.identifier).style.position = "fixed";

    window.MM.getModules = () => allModules;

    Module.handleModuleVisibility.call({
      identifier: "module_0_MMM-Remote-Control",
      name: "MMM-Remote-Control",
      getModulesByFilter: Module.getModulesByFilter,
      restoreStuckSiblings: Module.restoreStuckSiblings
    }, "HIDE", {module: "module_1_pix"});

    assert.deepEqual(shown, ["module_2_qr"]);
  });

  test("getModulesByFilter warns when one name matches multiple instances", () => {
    const warnings = [];
    window.Log.warn = (message) => { warnings.push(message); };
    window.MM.getModules = () => [
      {identifier: "module_1_MMM-EasyPix", name: "MMM-EasyPix"},
      {identifier: "module_2_MMM-EasyPix", name: "MMM-EasyPix"}
    ];

    const matches = Module.getModulesByFilter.call({name: "MMM-Remote-Control"}, "MMM-EasyPix");

    assert.equal(matches.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /module_1_MMM-EasyPix, module_2_MMM-EasyPix/u);
  });
});

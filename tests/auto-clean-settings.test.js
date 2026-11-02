const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const ROOT = path.resolve(__dirname, "..");
const source = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function page(saved = {}) {
  const dom = new JSDOM(source("settings.html"), { runScripts: "outside-only", url: "https://fixture.test/settings.html" });
  const { window } = dom;
  const store = { laterOnSettings: saved };
  window.chrome = {
    storage: { local: {
      async get(key) { return { [key]: store[key] }; },
      async set(patch) { Object.assign(store, patch); }
    }, onChanged: { addListener() {} } },
    commands: { async getAll() { return []; } },
    runtime: { async sendMessage() { return {}; }, getURL: p => p }
  };
  window.eval(source("i18n.js"));
  window.eval(source("theme.js"));
  window.eval(source("settings.js"));
  await tick();
  return { dom, window, store, input: window.document.querySelector('[data-setting="autoCleanDays"]') };
}
(async () => {
  for (const [saved, expected] of [[{}, ""], [{ autoCleanDays: null }, ""], [{ autoCleanDays: 0 }, "0"], [{ autoCleanDays: 30 }, "30"], [{ autoCleanDays: 999 }, "999"]]) {
    const { dom, input } = await page(saved);
    try { assert.equal(input.value, expected, "Restore blank, zero and existing custom settings without clamping"); }
    finally { dom.window.close(); }
  }
  const { dom, window, store, input } = await page();
  try {
    assert.equal(input.min, "0");
    assert.equal(input.max, "");
    assert.equal(input.step, "1");
    for (const [value, expected] of [["1", 1], ["999", 999], ["1000000", 1000000], ["0", 0], ["", null]]) {
      input.value = value;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
      assert.equal(store.laterOnSettings.autoCleanDays, expected, `Persist ${value || "blank"} correctly`);
      assert.equal(input.value, value);
    }
    for (const value of ["-1", "1.5"]) {
      input.value = value;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await tick();
      assert.equal(store.laterOnSettings.autoCleanDays, null, "Invalid input must not enable immediate deletion");
      assert.equal(input.checkValidity(), false);
    }
    for (const language of ["zh-CN", "en"]) {
      await window.LaterOnI18n.setLanguage(language);
      window.LaterOnI18n.applyStatic();
      const hint = window.document.querySelector('[data-i18n="autoCleanHint"]').textContent;
      assert(!hint.includes("180"));
      assert(hint.includes("0") && hint.includes("1"));
      assert(input.placeholder.length > 0);
      assert(!window.LaterOnI18n.t("guideStepReadHint").includes("30"));
    }
    console.log("PASS auto-clean settings: defaults, restore, arbitrary days, zero, clearing, validation and both languages");
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

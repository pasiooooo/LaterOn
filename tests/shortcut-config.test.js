const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const settings = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
const settingsHtml = fs.readFileSync(path.join(ROOT, "settings.html"), "utf8");
const theme = fs.readFileSync(path.join(ROOT, "theme.js"), "utf8");
const background = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

assert.equal(manifest.commands["quick-switcher"].suggested_key.default, "Alt+O", "Quick Switcher owns the native browser default");
assert.equal(Object.values(manifest.commands).filter(command => command.suggested_key).length, 4, "Chrome permits four suggested shortcuts");
assert.equal(manifest.commands["save-window-tabs"].suggested_key, undefined, "Window saving remains configurable without a fifth native suggestion");
const keyboard = fs.readFileSync(path.join(ROOT, "keyboard-shortcuts.js"), "utf8");
assert.match(keyboard, /Digit2/); assert.match(keyboard, /altKey/); assert.match(keyboard, /shiftKey/);
assert.match(keyboard, /windowShortcutFallback/);
assert.match(settings, /"#cmdQuickSwitcher", "Alt\+O"/);
assert.match(settings, /shortcutWebFallback/);
assert.match(readme, /按 `Alt\+Shift\+2`/);
assert.match(settingsHtml, /默认关闭/);
assert.doesNotMatch(settingsHtml, /默认开启/);
assert.match(theme, /askFolderOnSingle:\s*false/);
assert.match(theme, /askFolderOnSingleOptIn:\s*false/);
assert.match(theme, /windowShortcutFallback:\s*true/);
assert.match(background, /settings\.askFolderOnSingle\s*===\s*true\s*&&\s*settings\.askFolderOnSingleOptIn\s*===\s*true/);

for (const page of ["library.html", "bookmarks.html", "sidepanel.html", "settings.html"]) {
  const doc = new JSDOM(fs.readFileSync(path.join(ROOT, page), "utf8")).window.document;
  const scripts = [...doc.scripts];
  const names = ["picker-keyboard-guard.js", "keyboard-shortcuts.js", "quick-switcher-ui.js", "quick-switcher-client.js"];
  const indexes = names.map(name => scripts.findIndex(script => script.getAttribute("src") === name));
  assert(indexes.every((index, n) => index >= 0 && (!n || indexes[n - 1] < index)), `${page} loads keyboard guard and switcher in order`);
  for (const index of indexes) assert(scripts[index].defer, `${page} loads switcher scripts without blocking first paint`);
  const pageScript = scripts.find(script => /^(?:library|bookmarks|sidepanel)\.js$/.test(script.getAttribute("src") || ""));
  if (pageScript) assert(pageScript.defer, `${page} registers its keyboard listeners after the guard`);
  assert(doc.querySelector('[data-quick-switcher]'), `${page} offers a compact or settings entry point`);
}

const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const waitFor = async check => {
  const until = Date.now() + 2000;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert(check(), "Settings shortcut rows become ready");
};
async function boot(commands, preferences = {}) {
  const errors = [], vc = new VirtualConsole(); vc.on("jsdomError", error => errors.push(error.message));
  const dom = new JSDOM(settingsHtml, { runScripts: "outside-only", url: "chrome-extension://fixture/settings.html", virtualConsole: vc });
  const w = dom.window, store = { laterOnSettings: { language: "en", ...preferences } };
  w.chrome = { storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]])); },
    async set(patch) { Object.assign(store, patch); } }, onChanged: { addListener() {} } }, commands: { async getAll() { return commands; } },
    runtime: { getURL: name => `chrome-extension://fixture/${name}`, async sendMessage() { return {}; } } };
  for (const source of ["theme.js", "i18n.js", "settings.js"]) w.eval(read(source));
  await waitFor(() => /Alt\+O/.test(w.document.querySelector("#cmdQuickSwitcher").textContent));
  return { dom, w, store, errors };
}
(async () => {
  const fallback = await boot([{ name: "quick-switcher", shortcut: "Alt+O" }]);
  try {
    const checkbox = fallback.w.document.querySelector('[data-setting="windowShortcutFallback"]');
    assert.equal(checkbox.checked, true, "The web-page fallback starts enabled");
    assert.match(fallback.w.document.querySelector("#cmdSaveAll").textContent, /Alt\+Shift\+2.*web-page fallback/);
    checkbox.checked = false; checkbox.dispatchEvent(new fallback.w.Event("change", { bubbles: true }));
    await waitFor(() => fallback.store.laterOnSettings.windowShortcutFallback === false);
    assert.match(fallback.w.document.querySelector("#cmdSaveAll").textContent, /fallback is off/);
    assert.deepEqual(fallback.errors, []);
  } finally { fallback.w.close(); }
  const native = await boot([{ name: "quick-switcher", shortcut: "Ctrl+Shift+O" }, { name: "save-window-tabs", shortcut: "Ctrl+Shift+W" }]);
  try {
    assert.match(native.w.document.querySelector("#cmdQuickSwitcher").textContent, /Ctrl\+Shift\+O/);
    assert.equal(native.w.document.querySelector("#cmdSaveAll").textContent, "Ctrl+Shift+W (browser shortcut)", "User-native bindings take precedence over fallback hints");
    assert.deepEqual(native.errors, []);
  } finally { native.w.close(); }
  console.log("PASS shortcuts: native Alt+O within four suggestions, opt-out web fallback, live setting persistence, actual custom bindings and page entry wiring");
})().catch(error => { console.error(error); process.exitCode = 1; });

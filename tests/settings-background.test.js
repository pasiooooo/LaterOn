const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const files = Object.fromEntries(['quick-switcher-modes.js', 'settings-background.js', 'theme.js', 'i18n.js']
  .map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
function fixture() {
  let stored = { theme: 'light', language: 'zh-CN', retained: 'private-local-preference' }, gate = null, fail = false, reads = 0;
  const listeners = [], watchers = [], writes = [], rawWrites = [];
  const chrome = { runtime: { id: 'fixture', getURL: name => `chrome-extension://fixture/${name}`,
    onMessage: { addListener(fn) { listeners.push(fn); } } }, storage: { local: {
      async get() { reads++; const snapshot = clone(stored); if (gate) await gate; return { laterOnSettings: snapshot }; },
      async set(patch) {
        if (fail) throw Error('Synthetic storage failure');
        const before = stored; stored = clone(patch.laterOnSettings); writes.push(clone(stored)); rawWrites.push(clone(patch));
        for (const watcher of watchers) watcher({ laterOnSettings: { oldValue: before, newValue: clone(stored) } }, 'local');
      }
    }, onChanged: { addListener(fn) { watchers.push(fn); } } } };
  const context = vm.createContext({ chrome });
  vm.runInContext(files['quick-switcher-modes.js'], context); vm.runInContext(files['settings-background.js'], context);
  const sender = { id: 'fixture', url: 'chrome-extension://fixture/settings.html' };
  const request = (patch, from = sender, order) => new Promise(resolve => {
    assert.equal(listeners.length, 1); listeners[0]({ type: 'LATERON_SETTINGS_SET', patch, ...(order !== undefined ? { order } : {}) }, from, resolve);
  });
  return { chrome, context, request, writes, rawWrites, listeners,
    get state() { return clone(stored); }, get reads() { return reads; },
    pause() { let release; gate = new Promise(resolve => { release = resolve; }); return () => { gate = null; release(); }; },
    fail(value) { fail = value; },
    page(name) {
      const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body></body></html>', { url: chrome.runtime.getURL(name), runScripts: 'outside-only' });
      dom.window.matchMedia = () => ({ matches: false, addEventListener() {} });
      dom.window.chrome = { ...chrome, runtime: { ...chrome.runtime,
        sendMessage: message => new Promise(resolve => listeners[0](message, { id: 'fixture', url: chrome.runtime.getURL(name) }, resolve)) } };
      dom.window.eval(files['theme.js']); dom.window.eval(files['i18n.js']);
      return dom;
    } };
}
(async () => {
  const worker = fixture();
  const modes = clone(worker.context.LaterOnQuickModes.normalize()); modes[0].sources = ['tabs', 'reading'];
  const release = worker.pause();
  const modeSave = worker.request({ quickSwitcherModes: modes }), themeSave = worker.request({ theme: 'dark' });
  await tick();
  assert.equal(worker.reads, 1, 'Only the first writer reads while its mutation is pending');
  release();
  const answers = await Promise.all([modeSave, themeSave]);
  assert(answers.every(answer => answer.ok));
  assert.deepEqual(worker.state.quickSwitcherModes[0].sources, ['tabs', 'reading']);
  assert.equal(worker.state.theme, 'dark'); assert.equal(worker.state.retained, 'private-local-preference');
  const before = worker.reads;
  assert.equal((await worker.request({ theme: 'light' }, { id: 'fixture', url: 'https://web.test/' })).error, 'settingsForbidden');
  assert.equal((await worker.request({ theme: 'light' }, { id: 'other', url: 'chrome-extension://fixture/settings.html' })).error, 'settingsForbidden');
  assert.equal(worker.reads, before, 'Web frames and other extensions cannot mutate settings');
  for (const invalid of [{ theme: 'invalid' }, { autoMarkRead: 'true' }, { autoCleanDays: -1 }, { unknown: true }, { quickSwitcherModes: [] }]) {
    assert.equal((await worker.request(invalid)).error, 'settingsInvalid');
  }
  const invalidModes = clone(modes); invalidModes[1].prefix = ' ';
  assert.equal((await worker.request({ quickSwitcherModes: invalidModes })).error, 'settingsInvalid');
  worker.fail(true);
  assert.equal((await worker.request({ language: 'en' })).error, 'settingsWriteFailed');
  worker.fail(false);
  assert.equal((await worker.request({ autoMarkRead: false })).ok, true, 'A failure does not poison the next queued write');
  assert.equal(worker.state.autoMarkRead, false);
  assert.equal((await worker.request({ askFolderOnSingle: false })).ok, true);
  assert.equal(worker.state.askFolderOnSingleOptIn, true, 'Explicit single-page preferences preserve the migration marker');
  assert.equal((await worker.request({ defaultSort: 'custom' }, undefined, { all: ['reading1', 'reading2'] })).ok, true);
  assert.deepEqual(worker.rawWrites.at(-1).laterOnOrder, { all: ['reading1', 'reading2'] });
  assert.equal(worker.rawWrites.at(-1).laterOnSettings.defaultSort, 'custom', 'Order and its sort preference publish in the same storage write');
  assert.equal((await worker.request({ defaultSort: 'custom' }, undefined, { all: [123] })).error, 'settingsInvalid');

  const shared = fixture(), first = shared.page('settings.html'), second = shared.page('library.html');
  try {
    await Promise.all([first.window.LaterOnI18n.ready, second.window.LaterOnI18n.ready]);
    await Promise.all([first.window.LaterOnSettings.set({ quickSwitcherModes: modes }),
      second.window.LaterOnSettings.set({ theme: 'dark' }), first.window.LaterOnI18n.setLanguage('en')]);
    assert.equal(shared.state.theme, 'dark'); assert.equal(shared.state.language, 'en');
    assert.deepEqual(shared.state.quickSwitcherModes[0].sources, ['tabs', 'reading']);
    assert.equal(first.window.document.documentElement.dataset.theme, 'dark');
    assert.equal(second.window.document.documentElement.dataset.theme, 'dark');
    assert(shared.writes.every(write => !('tabIds' in write)), 'Live tab state never enters preferences');
  } finally { first.window.close(); second.window.close(); }
  console.log('PASS shared settings writer: serialized concurrent modes/theme/language, cross-page updates, native sender checks, validation and failure recovery');
})().catch(error => { console.error(error); process.exitCode = 1; });

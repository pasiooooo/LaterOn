const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const listener of this.listeners) listener(...args); } });
const load = (context, file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
(async () => {
  const changed = event(), messages = [], tabMessages = [];
  const worker = vm.createContext({ chrome: { storage: { onChanged: changed },
    runtime: { async sendMessage(message) { messages.push(clone(message)); } },
    tabs: { async query() { return [{ id: 5, url: 'https://site.test/' }, { id: 6, url: 'chrome://settings/' }]; },
      async sendMessage(id, message) { tabMessages.push({ id, message: clone(message) }); } } } });
  load(worker, 'quick-switcher-modes.js'); load(worker, 'content-preferences-background.js');
  const modes = clone(worker.LaterOnQuickModes.normalize()); modes[1].prefix = '/'; modes[1].sources = ['tabs', 'bookmarks'];
  changed.emit({ laterOnItems: { newValue: [{ title: 'Synthetic large private payload' }] } }, 'local');
  assert.equal(messages.length, 0, 'Library writes never broadcast preferences');
  changed.emit({ laterOnSettings: { newValue: { theme: 'dark', language: 'en', windowShortcutFallback: false,
    quickSwitcherModes: modes.map(mode => ({ ...mode, ignoredSecret: 'synthetic-private-value' })), servicePassword: 'synthetic-private-value' } } }, 'local');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1); assert.equal(tabMessages.length, 1); assert.equal(tabMessages[0].id, 5);
  assert.deepEqual(messages[0].settings, { theme: 'dark', language: 'en', windowShortcutFallback: false, quickSwitcherModes: modes });
  assert.equal('servicePassword' in messages[0].settings, false);
  assert(messages[0].settings.quickSwitcherModes.every(mode => !('ignoredSecret' in mode)));
  assert(Buffer.byteLength(JSON.stringify(messages[0])) < 700, 'Preference messages remain small');
  const deferredQueries = [];
  worker.chrome.tabs.query = () => new Promise(resolve => deferredQueries.push(resolve));
  const older = clone(modes), newer = clone(modes); older[1].prefix = '!'; newer[1].prefix = '/';
  changed.emit({ laterOnSettings: { newValue: { quickSwitcherModes: older } } }, 'local');
  changed.emit({ laterOnSettings: { newValue: { quickSwitcherModes: newer } } }, 'local');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deferredQueries.length, 2);
  deferredQueries[1]([{ id: 5, url: 'https://site.test/' }]);
  await new Promise(resolve => setImmediate(resolve));
  deferredQueries[0]([{ id: 5, url: 'https://site.test/' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tabMessages.length, 2, 'A late query cannot deliver superseded settings');
  assert.equal(tabMessages.at(-1).message.settings.quickSwitcherModes[1].prefix, '/');

  let release; const lateRead = new Promise(resolve => { release = resolve; }); const received = event();
  const page = vm.createContext({ chrome: { runtime: { id: 'fixture', onMessage: received },
    storage: { local: { get: () => lateRead } } } });
  load(page, 'quick-switcher-modes.js'); load(page, 'content-preferences.js');
  const observed = []; page.LaterOnContentPreferences.subscribe(value => observed.push(clone(value)));
  received.emit({ type: 'LATERON_PREFERENCES', settings: messages[0].settings }, { id: 'other-extension' });
  assert.equal(observed.length, 0, 'An unrelated extension cannot replace preferences');
  received.emit(messages[0], { id: 'fixture' });
  release({ laterOnSettings: { quickSwitcherModes: clone(page.LaterOnQuickModes.normalize()) } });
  await page.LaterOnContentPreferences.ready;
  assert.equal(observed.length, 1);
  assert.deepEqual(clone(page.LaterOnContentPreferences.value.quickSwitcherModes), modes, 'A late initial read cannot overwrite a newer broadcast');
  assert.equal(page.chrome.storage.onChanged, undefined, 'Ordinary web frames require no full storage listener');
  console.log('PASS mode preference messages: small normalized payload, no library/secret data, sender validation and late-read race');
})().catch(error => { console.error(error); process.exitCode = 1; });

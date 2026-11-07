const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../quick-switcher-client.js'), 'utf8');
const presentation = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../quick-switcher-styles.js'), 'utf8'), presentation);
for (const [key, file] of [['theme', 'theme-vars.css'], ['component', 'quick-switcher.css']]) {
  assert.equal(presentation.LaterOnQuickSwitcherStyles[key], fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), 'Preloaded styles exactly match the canonical CSS');
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async (test, message) => { for (let i = 0; i < 100 && !test(); i++) await tick(); assert(test(), message); };
const extension = file => `chrome-extension://fixture/${file}`;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const listener of this.listeners) listener(...args); } });

function fixture(url = 'https://page.test/', reply, { localStyles = false } = {}) {
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><button id="open" data-quick-switcher>Quick Switcher</button><p id="quickSwitcherError" hidden>Error</p>', { url, runScripts: 'outside-only', virtualConsole: vc });
  const window = dom.window, calls = [], opened = [], currentCalls = [], refreshed = [];
  let current = null, responder = reply || (async message => message.type === 'QUICK_SWITCHER_CONTEXT'
    ? { ok: true, options: { language: 'en', theme: 'dark', styles: { theme: 'theme', component: 'component' } } }
    : { ok: true, results: [], total: 0 });
  const runtime = { onMessage: event(), getURL: extension, sendMessage(message) { calls.push(message); return responder(message); } };
  window.chrome = { runtime, storage: { onChanged: event() }, tabs: { async getCurrent() { currentCalls.push(true); return { id: 99, windowId: 90 }; } } };
  if (localStyles) Object.defineProperty(window.document, 'styleSheets', { configurable: true, value: [
    { href: extension('theme-vars.css'), cssRules: [{ cssText: ':root { color: red; }' }] },
    { href: extension('quick-switcher.css'), cssRules: [{ cssText: '.qs-dialog { display: grid; }' }] }
  ] });
  window.LaterOnQuickSwitcherUI = {
    open(options) { opened.push(options); current = { refresh() { refreshed.push(true); } }; return current; },
    close() { const old = current; current = null; if (old) opened.at(-1).onClose(); },
    get active() { return current; }
  };
  const load = () => window.eval(source); load();
  return { dom, window, calls, opened, currentCalls, refreshed, errors, runtime, load,
    reply(next) { responder = next; },
    message(message) { let response; for (const listener of runtime.onMessage.listeners) listener(message, { id: 'fixture' }, value => { response = value; }); return response; },
    change(key, area = 'local') { window.chrome.storage.onChanged.emit({ [key]: { newValue: [] } }, area); } };
}

(async () => {
  const web = fixture();
  try {
    const client = web.window.LaterOnQuickSwitcherClient;
    web.load();
    assert.equal(web.window.LaterOnQuickSwitcherClient, client);
    assert.equal(web.runtime.onMessage.listeners.length, 1, 'Reinjection does not stack message handlers');
    assert.equal(web.window.chrome.storage.onChanged.listeners.length, 1);
    web.window.document.querySelector('#open').click(); await tick();
    assert.equal(web.calls.length, 0, 'A website cannot turn its own data-quick-switcher element into a privileged launcher');
    assert.equal(web.opened.length, 0);
    assert.equal(web.message({ type: 'UNRELATED' }), undefined);
    const stale = web.message({ type: 'LATERON_QUICK_SWITCHER_SHOW', options: { expiresAt: web.window.Date.now() - 1 } });
    assert.equal(stale.ok, false);
    assert.equal(web.opened.length, 0, 'A stale worker show message cannot open after fallback');
    assert.equal(client.show({ expiresAt: web.window.Date.now() - 1 }), null);
    const options = { language: 'en', theme: 'dark', styles: { theme: 'theme', component: 'component' }, expiresAt: web.window.Date.now() + 1000 };
    assert.equal(web.message({ type: 'LATERON_QUICK_SWITCHER_SHOW', options }).ok, true);
    assert.equal(web.opened.length, 1);
    assert.equal(web.opened[0].language, 'en'); assert.equal(web.opened[0].theme, 'dark');
    assert.equal(web.opened[0].styles.component, 'component');
    web.reply(async message => ({ ok: true, results: [{ id: 'page:https://saved.test/', title: message.query, url: 'https://saved.test/' }], total: 1 }));
    const results = await web.opened[0].search('中文 search');
    assert.equal(results.total, 1);
    assert.equal(web.calls.at(-1).type, 'QUICK_SWITCHER_SEARCH');
    assert.equal(web.calls.at(-1).query, '中文 search');
    assert.equal(web.calls.at(-1).active, true, 'A query from an open UI renews worker activity after a restart');
    await web.opened[0].onOpen({ id: 'page:https://saved.test/', url: 'https://tampered.test/', title: 'Not authority' }, { newTab: true });
    const action = web.calls.at(-1);
    assert.equal(action.type, 'QUICK_SWITCHER_OPEN'); assert.equal(action.id, 'page:https://saved.test/');
    assert.equal(action.newTab, true); assert(!('url' in action), 'The worker resolves a verified result ID instead of accepting the displayed URL as navigation authority');
    web.reply(async () => ({ ok: false, error: 'quickSwitcherMissing' }));
    await assert.rejects(web.opened[0].onOpen({ id: 'deleted' }), /quickSwitcherMissing/, 'A deleted/permission-withdrawn result remains an actionable UI error');
    web.reply(async () => ({ ok: false, error: 'quickSwitcherUnavailable' }));
    await assert.rejects(web.opened[0].search('retry'), /quickSwitcherUnavailable/);
    web.reply(() => { throw Error('Extension context invalidated'); });
    await assert.rejects(web.opened[0].search('retry'), /Extension context invalidated/);
    web.reply(() => Promise.reject(new Error('Worker disconnected')));
    await assert.rejects(web.opened[0].onOpen({ id: 'old' }), /Worker disconnected/);
    for (const key of ['laterOnItems', 'laterOnProjects', 'laterOnBookmarkConfig', 'laterOnBookmarkState']) web.change(key);
    assert.equal(web.refreshed.length, 4, 'Relevant local changes refresh the open result slice');
    web.change('laterOnSettings'); web.change('laterOnItems', 'session');
    assert.equal(web.refreshed.length, 4);
    client.show(options);
    assert.equal(web.window.LaterOnQuickSwitcherUI.active, null, 'Repeated invocation toggles an open web modal closed');
    web.change('laterOnItems');
    assert.equal(web.refreshed.length, 4, 'A closed client does not refresh a detached modal');
    assert(!web.calls.some(call => call.type === 'QUICK_SWITCHER_CLOSE'), 'Closing a web overlay never asks to close its browser tab/window');
    const count = web.opened.length;
    web.window.LaterOnQuickSwitcherUI.open = () => { throw Error('Renderer unavailable'); };
    assert.equal(web.message({ type: 'LATERON_QUICK_SWITCHER_SHOW', options }).ok, false);
    assert.equal(web.opened.length, count);
    assert.deepEqual(web.errors, []);
  } finally { web.window.close(); }

  const owned = fixture(extension('library.html'));
  try {
    owned.window.document.querySelector('#open').click(); await tick();
    assert.equal(owned.calls.length, 1); assert.equal(owned.calls[0].type, 'QUICK_SWITCHER_SHOW', 'The explicit launcher on an extension page requests the shared switcher');
    assert.equal(owned.opened.length, 0, 'The worker owns choosing the correct current browser surface');
    const listener = owned.runtime.onMessage.listeners[0], replies = [];
    assert.equal(listener({ type: 'LATERON_QUICK_SWITCHER_SHOW', targetTabId: 98, options: {} }, {}, response => replies.push(response)), true);
    await tick(); await tick();
    assert.equal(owned.opened.length, 0); assert.equal(replies.length, 0, 'A different extension tab ignores a runtime broadcast without competing to respond');
    owned.window.LaterOnSidepanelSwitch = { isActive: () => false };
    listener({ type: 'LATERON_QUICK_SWITCHER_SHOW', targetTabId: 99, options: {} }, {}, response => replies.push(response));
    await tick(); await tick();
    assert.equal(owned.opened.length, 0); assert.equal(replies.length, 0, 'A retained hidden sidebar cannot steal the active surface broadcast');
    owned.window.LaterOnSidepanelSwitch = { isActive: () => true };
    listener({ type: 'LATERON_QUICK_SWITCHER_SHOW', targetTabId: 99, options: { language: 'en' } }, {}, response => replies.push(response));
    await until(() => replies.length === 1, 'The targeted extension client responds');
    assert.equal(owned.opened.length, 1); assert.equal(replies[0].ok, true);
    listener({ type: 'LATERON_QUICK_SWITCHER_SHOW', targetTabId: 98, options: {} }, {}, response => replies.push(response));
    await tick(); await tick();
    assert(owned.window.LaterOnQuickSwitcherUI.active, 'A broadcast for another tab cannot toggle this open client closed');
    assert.equal(replies.length, 1);
    listener({ type: 'LATERON_QUICK_SWITCHER_SHOW', targetTabId: 99, options: { expiresAt: owned.window.Date.now() - 1 } }, {}, response => replies.push(response));
    await until(() => replies.length === 2, 'The target reports expired context');
    assert.equal(replies[1].ok, false); assert.equal(owned.opened.length, 1, 'An expired targeted broadcast does not toggle the current modal');
  } finally { owned.window.close(); }

  const instant = fixture(`${extension('quick-switcher.html')}?window=4&theme=dark&language=en`,
    () => new Promise(() => {}), { localStyles: true });
  try {
    assert.equal(instant.opened.length, 1, 'A popup with local styles and worker presentation opens synchronously');
    assert.equal(instant.opened[0].theme, 'dark');
    assert.equal(instant.opened[0].language, 'en');
    assert.match(instant.opened[0].styles.theme, /:root/);
    assert.match(instant.opened[0].styles.component, /qs-dialog/);
    assert.equal(instant.calls.filter(message => message.type !== 'QUICK_SWITCHER_ACTIVITY').length, 0, 'The popup does not wait for another worker context request');
    assert.deepEqual(instant.errors, []);
  } finally { instant.window.close(); }

  const popup = fixture(`${extension('quick-switcher.html')}?window=4`);
  try {
    await until(() => popup.opened.length === 1, 'The protected-page popup loads its worker context');
    assert.equal(popup.calls[0].type, 'QUICK_SWITCHER_CONTEXT');
    assert.equal(popup.opened[0].language, 'en');
    popup.window.LaterOnQuickSwitcherUI.close();
    await until(() => popup.calls.some(call => call.type === 'QUICK_SWITCHER_CLOSE'), 'Popup close handshake arrives');
    assert.equal(popup.currentCalls.length, 1, 'The popup can identify itself even when runtime Sender.tab is absent');
    assert.equal(popup.calls.at(-1).tabId, 99);
    popup.window.LaterOnQuickSwitcherClient.show({ language: 'en' });
    popup.reply(() => { throw Error('Extension context invalidated'); });
    assert.doesNotThrow(() => popup.window.LaterOnQuickSwitcherUI.close()); await tick(); await tick();
    assert.deepEqual(popup.errors, [], 'Synchronous close failures from invalidated extension contexts stay contained');
  } finally { popup.window.close(); }

  // Extension pages read the prepared index directly, unless a newer source
  // revision is pending; then the worker answers with current Reading data.
  const page = fixture(extension('library.html'));
  try {
    let pending = null, localQueries = 0, enabled = false, bookmarkVariant = false;
    page.window.chrome.storage.local = { async get(keys) { return { laterOnBookmarkConfig: { enabled }, ...(pending ? { laterOnQuickSearchPending: pending } : {}) }; } };
    page.window.chrome.permissions = { async contains() { return enabled; } };
    page.window.LaterOnQuickSearch = {};
    page.window.LaterOnLocalIndex = { supported: () => true, async search() { localQueries++; return { results: [], total: 0, revision: 7, bookmarkVariant }; } };
    page.window.LaterOnQuickSwitcherClient.show({ language: 'en' });
    page.reply(async () => ({ ok: true, results: [], total: 3, provisional: true }));
    assert.equal((await page.opened.at(-1).search('x')).total, 0, 'A current prepared index answers locally');
    assert.equal(page.calls.filter(call => call.type === 'QUICK_SWITCHER_SEARCH').length, 0);
    pending = { revision: 9 };
    const delegated = await page.opened.at(-1).search('x');
    assert.equal(delegated.provisional, true, 'A pending source revision routes the query to the worker');
    assert.equal(page.calls.filter(call => call.type === 'QUICK_SWITCHER_SEARCH').length, 1);
    assert.equal(page.calls.at(-1).active, true, 'A pending direct-index query renews activity when it delegates');
    assert.equal(localQueries, 2);
    const before = page.refreshed.length;
    page.change('laterOnQuickSearchPending');
    assert.equal(page.refreshed.length, before + 1, 'Marker changes refresh an open dialog');
    page.message({ type: 'LATERON_QUICK_SWITCHER_CHANGED', fresh: true });
    assert.equal(page.refreshed.length, before + 2, 'A fresh commit refreshes an open dialog');
    pending = null; enabled = true;
    assert.equal((await page.opened.at(-1).search('native')).provisional, true, 'An enabled bookmark library cannot use a Reading-only local snapshot as complete');
    assert.equal(page.calls.filter(call => call.type === 'QUICK_SWITCHER_SEARCH').length, 2);
    bookmarkVariant = true;
    assert.equal((await page.opened.at(-1).search('native')).total, 0, 'A current combined snapshot keeps answering directly');
    assert.equal(page.calls.filter(call => call.type === 'QUICK_SWITCHER_SEARCH').length, 2);
    let release;
    page.window.chrome.storage.local.get = () => new Promise(resolve => { release = resolve; });
    const delayed = page.opened.at(-1).search('closed');
    page.window.LaterOnQuickSwitcherUI.close();
    release({ laterOnBookmarkConfig: { enabled: true }, laterOnQuickSearchPending: { revision: 9 } });
    await delayed;
    assert.equal(page.calls.at(-1).active, false, 'A delayed query cannot renew activity after its UI closes');
  } finally { page.window.close(); }

  const failure = fixture(`${extension('quick-switcher.html')}?window=4`, async () => ({ ok: false, error: 'Unavailable' }));
  try {
    await until(() => !failure.window.document.querySelector('#quickSwitcherError').hidden, 'Bootstrap failure exposes the standalone recovery message');
    assert.equal(failure.opened.length, 0); assert.deepEqual(failure.errors, []);
  } finally { failure.window.close(); }
  console.log('PASS quick-switcher client: source-limited launch controls, expiring opens, singleton, search/action failure propagation, live invalidation, pending-revision delegation, toggling and safe popup close');
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async (test, message) => { for (let i = 0; i < 100 && !test(); i++) await tick(); assert(test(), message); };
const extension = file => `chrome-extension://fixture/${file}`;
const saved = 'https://article.test/paper?q=alpha#one';
const sourceTab = () => ({ id: 1, windowId: 4, active: true, url: 'https://source.test/' });
const sender = tab => ({ url: tab.url, tab: { ...tab } });

function fixture(patch = {}) {
  const store = { laterOnItems: [{ id: 'reading', title: 'Saved paper', url: saved, savedAt: 10, status: 'done' }],
    laterOnProjects: [], laterOnSettings: { language: 'en', theme: 'dark', quickSwitcherModes: [{ id: 'default', prefix: '', sources: ['reading', 'bookmarks'] }] },
    laterOnBookmarkConfig: { enabled: true, scopeId: null },
    laterOnBookmarkState: { enabled: true, scopeId: null, nodes: [{ id: 'bookmark', title: 'Bookmark only', url: 'https://book.test/' }] }, ...clone(patch) };
  let granted = true, nextTab = 100;
  const tabs = [sourceTab()], windows = [{ id: 4, type: 'normal', left: 100, top: 20, width: 1200, incognito: false }];
  const nativeNodes = [{ id: '0' }, { id: 'scope', parentId: '0', title: 'Scope' }, { id: 'else', parentId: '0', title: 'Elsewhere' },
    { id: 'bookmark', parentId: 'scope', title: 'Bookmark only', url: 'https://book.test/' }];
  const calls = { gets: [], fetches: [], messages: [], runtimeMessages: [], injections: [], creates: [], updates: [], focuses: [], popups: [], removes: [], removedTabs: [], writes: [], legacy: [], nativeGets: [] };
  const chrome = {
    runtime: { id: 'fixture', getURL: extension, onMessage: event(), async sendMessage(message) { calls.runtimeMessages.push(message); return { ok: true }; } },
    permissions: { async contains() { return granted; }, onAdded: event(), onRemoved: event() },
    storage: { local: { async get(keys) { calls.gets.push(clone(keys)); return clone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]]))); },
      async set(value) { calls.writes.push(clone(value)); Object.assign(store, clone(value)); chrome.storage.onChanged.emit(Object.fromEntries(Object.entries(value).map(([key, next]) => [key, { newValue: next }])), 'local'); } }, onChanged: event() },
    tabs: { async query(query) { return clone(tabs.filter(tab => !query.active || tab.active).filter(tab => query.windowId == null || tab.windowId === query.windowId)); },
      async sendMessage(id, message) { calls.messages.push({ id, message }); return { ok: true }; },
      async create(value) { const tab = { id: nextTab++, windowId: value.windowId ?? 4, ...value }; calls.creates.push(clone(value)); tabs.push(tab); return clone(tab); },
      async update(id, value) { calls.updates.push({ id, value: clone(value) }); const tab = tabs.find(entry => entry.id === id); if (!tab) throw Error('Missing tab'); Object.assign(tab, value); return clone(tab); },
      async get(id) { const tab = tabs.find(entry => entry.id === id); if (!tab) throw Error('Missing tab'); return clone(tab); },
      async remove(id) { calls.removedTabs.push(id); } },
    windows: { async get(id) { const value = windows.find(entry => entry.id === id); if (!value) throw Error('Missing window'); return clone(value); },
      async getAll(query = {}) { return clone(windows.filter(window => !query.windowTypes || query.windowTypes.includes(window.type))); }, async update(id, value) { calls.focuses.push({ id, value }); return { id, ...value }; },
      async create(value) { const window = { id: 90 + calls.popups.length, ...value }; calls.popups.push(clone(value)); windows.push(window); return clone(window); },
      async remove(id) { calls.removes.push(id); } },
    bookmarks: { async get(id) { calls.nativeGets.push(id); if (!granted) throw Error('Permission revoked'); const node = nativeNodes.find(node => node.id === id); if (!node) throw Error('Missing bookmark'); return [clone(node)]; } },
    scripting: { async executeScript(value) { calls.injections.push(value); return value.files ? [] : [{ result: true }]; } },
    commands: { async getAll() { return [{ name: 'save-window-tabs', shortcut: '' }]; } }
  };
  const timers = new Map(), clock = { value: Date.now() }; let timerId = 0;
  class ClockDate extends Date { static now() { return clock.value; } }
  const context = vm.createContext({ chrome, URL, Date: ClockDate, console,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    async fetch(url) { calls.fetches.push(url); return { ok: true, async text() { return `/* ${url} */`; } }; },
    async saveAllTabsInWindow(...args) { calls.legacy.push(args); } });
  for (const file of ['url-utils.js', 'quick-switcher-modes.js', 'quick-switcher-search.js', 'quick-switcher-background.js']) vm.runInContext(read(file), context);
  return { store, chrome, tabs, windows, nativeNodes, calls, timers, clock, context, api: context.LaterOnQuickSwitcher,
    revoke() { granted = false; chrome.permissions.onRemoved.emit({ permissions: ['bookmarks'] }); },
    grant() { granted = true; chrome.permissions.onAdded.emit({ permissions: ['bookmarks'] }); },
    fireTimeout() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); } };
}

(async () => {
  const cache = fixture();
  for (const query of ['', 'saved', 'saved paper', 'book']) await cache.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query }, sender(sourceTab()));
  assert.equal(cache.calls.gets.filter(keys => Array.isArray(keys) && keys.includes('laterOnItems')).length, 1, 'Typing searches reuses one lean index instead of rereading the library per character');
  assert.equal(cache.calls.fetches.length, 0, 'Searching uses local data and does not fetch covers or sites');
  cache.store.laterOnItems.push({ id: 'later', title: 'Added later', url: 'https://later.test/' });
  cache.chrome.storage.onChanged.emit({ laterOnItems: { newValue: cache.store.laterOnItems } }, 'local');
  assert.equal((await cache.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query: 'Added later' }, sender(sourceTab()))).total, 1);
  assert.equal(cache.calls.gets.filter(keys => Array.isArray(keys) && keys.includes('laterOnItems')).length, 2, 'Collection changes invalidate the index');
  const bookId = (await cache.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query: 'Bookmark only' }, sender(sourceTab()))).results[0].id;
  cache.revoke();
  await assert.rejects(cache.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: bookId }, sender(sourceTab())), /quickSwitcherMissing/, 'A permission-revoked result cannot open from an old displayed slice');
  assert.equal(cache.calls.creates.length, 0);
  cache.grant();
  const readId = (await cache.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query: 'Saved paper' }, sender(sourceTab()))).results[0].id;
  cache.store.laterOnItems = [];
  await assert.rejects(cache.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: readId }, sender(sourceTab())), /quickSwitcherMissing/, 'Opening rechecks membership even before a storage-change event arrives');

  const native = fixture();
  await Promise.all([native.api.open(sourceTab()), native.api.open(sourceTab())]);
  assert.equal(native.calls.messages.length, 1, 'Fast repeated native invocations coalesce one open transaction');
  assert.equal(native.calls.messages[0].message.type, 'LATERON_QUICK_SWITCHER_SHOW');
  assert.equal(native.calls.injections.length, 0); assert.equal(native.calls.popups.length, 0);
  assert.equal(native.calls.fetches.length, 0, 'A preloaded component opens without a worker settings read or style fetch');

  const owned = fixture();
  await owned.api.open({ id: 9, windowId: 4, url: extension('library.html') });
  assert.equal(owned.calls.messages.length, 0, 'Extension documents do not use the content-script tabs.sendMessage transport');
  assert.equal(owned.calls.runtimeMessages.length, 1);
  assert.equal(owned.calls.runtimeMessages[0].targetTabId, 9, 'Runtime broadcast carries the exact extension tab target');
  assert.equal(owned.calls.popups.length, 0);

  const injected = fixture();
  injected.chrome.tabs.sendMessage = async () => { throw Error('No receiver'); };
  await injected.api.open(sourceTab());
  assert(injected.calls.injections[0].files.includes('picker-keyboard-guard.js'));
  assert(injected.calls.injections[0].files.includes('quick-switcher-client.js'));
  assert.equal(injected.calls.injections[0].target.tabId, 1);
  assert.equal(typeof injected.calls.injections[1].func, 'function');
  assert.equal(injected.calls.popups.length, 0, 'An ordinary web page receives the modal without a new tab or browser window');

  const protectedPage = fixture();
  const protectedTab = { ...sourceTab(), url: 'chrome://settings/' };
  protectedPage.chrome.tabs.sendMessage = async () => { throw Error('Protected page'); };
  await protectedPage.api.open(protectedTab);
  assert.equal(protectedPage.calls.injections.length, 0);
  assert.equal(protectedPage.calls.popups.length, 1);
  assert.equal(protectedPage.calls.popups[0].type, 'popup');
  assert.equal(new URL(protectedPage.calls.popups[0].url).searchParams.get('window'), '4', 'Protected-page fallback remembers its originating browser window');
  assert.equal(new URL(protectedPage.calls.popups[0].url).searchParams.get('theme'), 'dark', 'The popup receives presentation already read by the worker');
  assert.equal(new URL(protectedPage.calls.popups[0].url).searchParams.get('language'), 'en');
  protectedPage.tabs.push({ id: 90, windowId: 90, url: `${extension('quick-switcher.html')}?window=8` });
  await protectedPage.api.open(protectedTab);
  assert.equal(protectedPage.calls.popups.length, 1, 'A later fallback reuses the existing Quick Switcher window');
  assert.equal(new URL(protectedPage.calls.updates.at(-1).value.url).searchParams.get('window'), '4');

  const normalSwitcher = fixture();
  normalSwitcher.chrome.tabs.sendMessage = async () => { throw Error('Protected page'); };
  normalSwitcher.tabs.push({ id: 9, windowId: 4, url: extension('quick-switcher.html') });
  await normalSwitcher.api.open(protectedTab);
  assert.equal(normalSwitcher.calls.popups.length, 1, 'A switcher URL in a normal browser tab is not mistaken for the reusable popup');
  assert.equal(normalSwitcher.calls.updates.length, 0);
  const popupReentry = fixture();
  const originalPopupTab = { id: 90, windowId: 90, url: `${extension('quick-switcher.html')}?window=4` };
  popupReentry.tabs.push(originalPopupTab); popupReentry.windows.push({ id: 90, type: 'popup' });
  popupReentry.chrome.runtime.sendMessage = async () => { throw Error('Popup renderer unavailable'); };
  await popupReentry.api.open(originalPopupTab);
  assert.equal(new URL(popupReentry.calls.updates.at(-1).value.url).searchParams.get('window'), '4', 'A popup fallback retains its original normal browser window rather than chaining its popup ID');

  const exact = fixture();
  exact.tabs.push({ id: 2, windowId: 4, active: false, url: saved }, { id: 3, windowId: 8, active: true, url: saved },
    { id: 4, windowId: 4, active: false, url: 'https://article.test/paper?q=alpha#two' },
    { id: 5, windowId: 4, active: false, url: 'https://article.test/paper?q=beta#one' });
  const entry = (await exact.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query: 'Saved paper' }, sender(sourceTab()))).results[0];
  assert.equal((await exact.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: entry.id }, sender(sourceTab()))).reused, true);
  assert.equal(exact.calls.updates.at(-1).id, 2, 'Reuse prefers an exact URL in the originating window');
  assert.equal(exact.calls.focuses.at(-1).id, 4);
  assert.equal(exact.calls.writes.at(-1).laterOnCurrentItem, 'reading');
  await exact.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: entry.id, newTab: true }, sender(sourceTab()));
  assert.equal(exact.calls.creates.at(-1).url, saved, 'Modified confirmation explicitly opens a fresh tab');
  assert.equal(exact.calls.creates.at(-1).windowId, 4);
  const returning = fixture();
  const selected = (await returning.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query: '' }, sender(sourceTab()))).results.find(result => result.readingIds.length);
  await returning.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: selected.id }, { url: `${extension('quick-switcher.html')}?window=4`, tab: { id: 99, windowId: 90 } });
  assert.equal(returning.calls.creates.at(-1).windowId, 4, 'A popup result opens into the original browser window rather than into the popup');
  const ownPopup = { id: 99, windowId: 90, url: `${extension('quick-switcher.html')}?window=4` };
  returning.tabs.push(ownPopup); returning.windows.push({ id: 90, type: 'popup' });
  await returning.api.handle({ type: 'QUICK_SWITCHER_CLOSE' }, { url: ownPopup.url, tab: ownPopup });
  assert.deepEqual(returning.calls.removes, [90]);
  const wrongOrigin = fixture(); wrongOrigin.windows.push({ id: 90, type: 'popup' });
  await wrongOrigin.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: `page:${saved}` }, { url: `${extension('quick-switcher.html')}?window=90` });
  assert.equal(wrongOrigin.calls.creates.at(-1).windowId, 4, 'Only a normal window can serve as popup navigation origin');

  for (const { url, pendingUrl, reuse } of [
    { url: saved, pendingUrl: 'https://leaving.test/', reuse: false },
    { url: 'https://before.test/', pendingUrl: saved, reuse: true },
    { url: 'https://article.test/paper?q=alpha#two', reuse: false },
    { url: 'https://article.test/paper?q=beta#one', reuse: false }
  ]) {
    const pending = fixture(); pending.tabs.push({ id: 2, windowId: 4, active: false, url, pendingUrl });
    const result = await pending.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: `page:${saved}` }, sender(sourceTab()));
    assert.equal(result.reused, reuse, 'Reuse follows an exact pending destination, preserving query and hash identity');
    assert.equal(pending.calls.creates.length, Number(!reuse));
  }

  const stale = fixture({ laterOnItems: [] });
  const staleId = (await stale.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query: '' }, sender(sourceTab()))).results[0].id;
  stale.nativeNodes.splice(stale.nativeNodes.findIndex(node => node.id === 'bookmark'), 1);
  await assert.rejects(stale.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: staleId }, sender(sourceTab())), /quickSwitcherMissing/, 'Native deletion blocks opening before the bookmark cache publishes its change');
  assert.equal(stale.calls.creates.length, 0);
  const moved = fixture({ laterOnItems: [], laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' },
    laterOnBookmarkState: { enabled: true, scopeId: 'scope', nodes: [{ id: 'scope', title: 'Scope' }, { id: 'bookmark', parentId: 'scope', title: 'Bookmark only', url: 'https://book.test/' }] } });
  moved.nativeNodes.find(node => node.id === 'bookmark').parentId = 'else';
  await assert.rejects(moved.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: 'page:https://book.test/' }, sender(sourceTab())), /quickSwitcherMissing/, 'Fresh native ancestry prevents opening a bookmark moved outside the synchronized scope');
  assert(moved.calls.nativeGets.includes('else') && moved.calls.nativeGets.includes('0'));
  assert.equal(moved.calls.creates.length, 0);

  for (const type of ['popup', 'normal']) {
    const close = fixture();
    const tab = { id: 99, windowId: type === 'popup' ? 90 : 4, url: `${extension('quick-switcher.html')}?window=4` };
    close.tabs.push(tab); if (type === 'popup') close.windows.push({ id: 90, type: 'popup' });
    await close.api.handle({ type: 'QUICK_SWITCHER_CLOSE', tabId: 99 }, { url: tab.url });
    if (type === 'popup') assert.deepEqual(close.calls.removes, [90], 'An extension-page sender without tab information can close its verified sole-tab popup');
    else { assert.deepEqual(close.calls.removes, []); assert.deepEqual(close.calls.removedTabs, [99], 'A switcher opened as a normal tab never closes the browser window'); }
    await close.api.handle({ type: 'QUICK_SWITCHER_CLOSE', tabId: 1 }, { url: tab.url });
    assert(!close.calls.removedTabs.includes(1), 'A supplied ID cannot close another URL');
  }
  const multi = fixture(); multi.windows.push({ id: 90, type: 'popup' });
  const switchTab = { id: 99, windowId: 90, url: `${extension('quick-switcher.html')}?window=4` };
  multi.tabs.push(switchTab, { id: 98, windowId: 90, url: 'https://other.test/' });
  await multi.api.handle({ type: 'QUICK_SWITCHER_CLOSE' }, { url: switchTab.url, tab: switchTab });
  assert.deepEqual(multi.calls.removes, []); assert.deepEqual(multi.calls.removedTabs, [99], 'Closing a multi-tab popup preserves the unrelated tab');

  const noOrigin = fixture(); noOrigin.windows.splice(0, 1); noOrigin.tabs.splice(0, 1);
  await noOrigin.api.handle({ type: 'QUICK_SWITCHER_OPEN', id: `page:${saved}` }, { url: `${extension('quick-switcher.html')}?window=4` });
  assert.equal(noOrigin.calls.creates.length, 0);
  assert.equal(noOrigin.calls.popups[0].type, 'normal', 'If the original browser closes, opening creates a normal browser window instead of a tab inside the search popup');

  const delayed = fixture(); delayed.chrome.tabs.sendMessage = async () => { throw Error('No receiver'); };
  delayed.chrome.scripting.executeScript = value => { delayed.calls.injections.push(value); return value.files ? Promise.resolve([]) : new Promise(() => {}); };
  const showing = delayed.api.open(sourceTab());
  await until(() => delayed.calls.injections.length === 2 && delayed.timers.size, 'The injected modal show is awaiting a renderer response');
  const late = delayed.calls.injections[1]; delayed.clock.value = late.args[0].expiresAt + 1; delayed.fireTimeout(); await showing;
  assert.equal(delayed.calls.popups.length, 1, 'An unresponsive page falls back to the isolated popup');
  let lateShows = 0; delayed.context.LaterOnQuickSwitcherClient = { show() { lateShows++; } };
  assert.equal(late.func(...late.args), false);
  assert.equal(lateShows, 0, 'The delayed injected function cannot open a second overlay after fallback');

  const legacy = fixture();
  assert.equal((await legacy.api.handle({ type: 'QUICK_SWITCHER_LEGACY_STATUS' }, sender(sourceTab()))).enabled, true);
  await legacy.api.handle({ type: 'QUICK_SWITCHER_LEGACY_WINDOW' }, sender(sourceTab()));
  assert.equal(legacy.calls.legacy.length, 1);
  legacy.chrome.commands.getAll = async () => [{ name: 'save-window-tabs', shortcut: 'Ctrl+Shift+Y' }];
  assert.equal((await legacy.api.handle({ type: 'QUICK_SWITCHER_LEGACY_STATUS' }, sender(sourceTab()))).enabled, false, 'Assigned native keys leave the old webpage key untouched');
  await legacy.api.handle({ type: 'QUICK_SWITCHER_LEGACY_WINDOW' }, sender(sourceTab()));
  assert.equal(legacy.calls.legacy.length, 1, 'An existing native binding suppresses the fallback instead of double-saving');
  legacy.store.laterOnSettings.windowShortcutFallback = false;
  legacy.chrome.commands.getAll = async () => [{ name: 'save-window-tabs', shortcut: '' }];
  assert.equal((await legacy.api.handle({ type: 'QUICK_SWITCHER_LEGACY_STATUS' }, sender(sourceTab()))).enabled, false, 'The availability handshake honors opt-out');
  await legacy.api.handle({ type: 'QUICK_SWITCHER_LEGACY_WINDOW' }, sender(sourceTab()));
  assert.equal(legacy.calls.legacy.length, 1, 'The worker independently honors fallback opt-out');

  const security = fixture();
  for (const invalid of [{ url: 'https://page.test/' }, { url: 'javascript:alert(1)', tab: sourceTab() },
    { url: 'file:///tmp/test.html', tab: sourceTab() }, { url: 'chrome-extension://other/library.html', tab: sourceTab() }]) {
    await assert.rejects(security.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query: '' }, invalid), /quickSwitcherUnavailable/);
  }
  assert.equal((await security.api.handle({ type: 'QUICK_SWITCHER_SEARCH', query: '' }, { url: extension('library.html') })).total, 2, 'Extension pages are authorized without pretending to be web tabs');
  const listener = security.chrome.runtime.onMessage.listeners[0];
  assert.doesNotThrow(() => listener({ type: 7 }, {}, () => {}), 'Malformed messages do not throw in the worker listener');
  assert.equal(listener({ type: 'UNRELATED' }, {}, () => {}), undefined);
  let rejected;
  assert.equal(listener({ type: 'QUICK_SWITCHER_SEARCH' }, { url: 'https://page.test/' }, result => { rejected = result; }), true);
  await until(() => rejected, 'Unauthorized runtime request completes');
  assert.equal(rejected.ok, false);
  assert.equal(security.calls.creates.length, 0); assert.equal(security.calls.legacy.length, 0);
  console.log('PASS quick-switcher background: index reuse/invalidation, permission and membership recheck, modal injection, protected popup handoff, exact tab reuse, legacy dedup and sender restrictions');
})().catch(error => { console.error(error); process.exitCode = 1; });

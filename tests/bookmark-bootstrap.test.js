const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); }, emit(...args) { this.handlers.forEach(fn => fn(...args)); } });
const roots = [{ id: '0', title: '' }, { id: '1', parentId: '0', title: 'Bookmarks bar' }, { id: '2', parentId: '0', title: 'Other' }];
const pages = Array.from({ length: 10000 }, (_, i) => ({ id: `b${i}`, parentId: i % 2 ? '1' : '2', title: `needle-${i}`, url: `https://example.test/${i}?q=x#one`, dateAdded: i }));
const nodes = [...roots, ...pages];
const stored = { laterOnBookmarkConfig: { enabled: true, scopeId: null }, laterOnBookmarkStateMeta: { enabled: true, scopeId: null, error: null, pages: 10000, updatedAt: 100, checkedAt: Date.now() } };
let granted = true, recentMaximum = 0, gets = [], fullReads = 0;
const messages = event();
const chrome = {
  storage: { onChanged: event(), local: { async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.includes('laterOnBookmarkState')) { fullReads++; throw Error('A first page cannot request the full mirror'); }
    return Object.fromEntries(list.filter(k => k in stored).map(k => [k, stored[k]]));
  }, async set(values) { Object.assign(stored, values); } } },
  permissions: { async contains() { return granted; }, onAdded: event(), onRemoved: event() },
  runtime: { getURL: name => `chrome-extension://fixture/${name}`, onMessage: messages, onInstalled: event(), onStartup: event() },
  bookmarks: {
    async getTree() { throw Error('A bounded first page must not read the whole native tree'); },
    async get(id) { gets.push(id); const n = nodes.find(n => n.id === id); if (!n) throw Error('missing'); return [n]; },
    async getChildren(id) { return nodes.filter(n => n.parentId === id); },
    async getRecent(limit) { recentMaximum = Math.max(recentMaximum, limit); return pages.slice().reverse().slice(0, limit); },
    async search(query) { return pages.filter(n => n.title.includes(query) || n.url.includes(query)); }
  },
  tabs: { async query() { return []; }, onActivated: event(), onUpdated: event() },
  alarms: { onAlarm: event() }
};
const context = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout });
vm.runInContext(read('bookmark-sync.js'), context);
const api = context.LaterOnBookmarkSync;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const until = async check => { for (let i = 0; i < 100 && !check(); i++) await tick(); assert(check()); };

(async () => {
  const first = await api.handle({ type: 'BOOKMARKS_VIEW', limit: 12 });
  assert.equal(first.nodes.filter(n => n.url).length, 12);
  assert.equal(first.view.totalPages, 10000, 'A known native count remains separate from the first page size');
  assert.equal(first.partial, true); assert.equal(first.provisional, true);
  assert.equal(recentMaximum, 12, 'Unprepared home reads a bounded native recent slice');
  assert(gets.length < 5, 'Only the visible pages ancestors are read');
  assert.equal(fullReads, 0);
  assert.equal(first.nodes.find(n => n.url).url, 'https://example.test/9999?q=x#one');
  const found = await api.handle({ type: 'BOOKMARKS_VIEW', query: 'needle-321', limit: 12 });
  assert(found.nodes.some(n => n.id === 'b321'));
  stored.laterOnBookmarkConfig.scopeId = '1';
  const scoped = await api.handle({ type: 'BOOKMARKS_VIEW', limit: 12 });
  assert(scoped.nodes.filter(n => n.url).every(n => n.parentId === '1'));
  assert(scoped.nodes.filter(n => !n.url).every(n => n.id === '1'), 'Ancestor folders outside the scope are metadata only, never view navigation');
  assert.equal(scoped.view.totalFolders, 1, 'The scoped home shows the scope root, like the prepared view');
  await assert.rejects(api.handle({ type: 'BOOKMARKS_VIEW', selected: '2', limit: 12 }), /bookmarkOutOfScope/);
  granted = false;
  await assert.rejects(api.handle({ type: 'BOOKMARKS_VIEW', limit: 12 }), /bookmarkPermission/);
  granted = true; stored.laterOnBookmarkConfig.scopeId = null;

  const dom = new JSDOM(read('bookmarks.html'), { runScripts: 'outside-only', url: 'chrome-extension://fixture/bookmarks.html?surface=sidepanel' });
  const w = dom.window;
  let indexed = false, ready = 0; const calls = [], payloads = [];
  w.chrome = { ...chrome, runtime: { ...chrome.runtime, async sendMessage(message) {
    calls.push(message.type);
    payloads.push(message);
    if (message.type === 'BOOKMARKS_VIEW') return { ok: true, state: await api.handle(message) };
    if (message.type === 'BOOKMARKS_CHECK') return { ok: true, state: { changed: false } };
    if (message.type === 'BOOKMARKS_GET') throw Error('Unprepared UI cannot ask for a full mirror');
    return { ok: true };
  } } };
  w.LaterOnI18n = { async getLanguage() { return 'en'; }, applyStatic() {} };
  w.LaterOnLocalIndex = { async bookmarkView(request) { return indexed ? { ...await api.handle({ type: 'BOOKMARKS_VIEW', ...request }), provisional: false } : null; } };
  w.LaterOnSidepanelSwitch = { isActive() { return true; }, ready() { ready++; } };
  for (const file of ['url-utils.js', 'bookmark-sidepanel.js', 'bookmark-view.js', 'bookmarks.js']) w.eval(read(file));
  try {
    await until(() => w.document.querySelectorAll('#bookmarkList .bookmark-card').length === 12);
    assert(calls.includes('BOOKMARKS_VIEW') && !calls.includes('BOOKMARKS_GET'));
    assert(ready > 0, 'Real bootstrap cards make the side panel ready');
    assert.equal(w.document.querySelector('#bookmarkEmpty').hidden, true);
    const activityBefore = calls.filter(type => type === 'BOOKMARKS_ACTIVITY').length;
    messages.emit({ type: 'BOOKMARKS_CHANGED', updatedAt: 100 }, { url: chrome.runtime.getURL('bookmarks.html') }, () => {});
    await until(() => payloads.some(message => message.type === 'BOOKMARKS_VIEW' && message.background === true));
    assert.equal(calls.filter(type => type === 'BOOKMARKS_ACTIVITY').length, activityBefore, 'Background publication is never reported as user input');
    let held = false, release;
    const gate = new Promise(resolve => { release = resolve; });
    const localView = w.LaterOnLocalIndex.bookmarkView;
    w.LaterOnLocalIndex.bookmarkView = async request => { if (!held) { held = true; await gate; } return localView(request); };
    messages.emit({ type: 'BOOKMARKS_CHANGED', updatedAt: 100 }, { url: chrome.runtime.getURL('bookmarks.html') }, () => {});
    await until(() => held);
    const input = w.document.querySelector('#bookmarkSearch');
    input.value = 'needle-321'; input.dispatchEvent(new w.Event('input'));
    release();
    await until(() => payloads.some(message => message.type === 'BOOKMARKS_VIEW' && message.query === 'needle-321' && message.background === false));
    assert(calls.filter(type => type === 'BOOKMARKS_ACTIVITY').length > activityBefore, 'Input coalesced with a background refresh retains user priority');
    input.value = ''; input.dispatchEvent(new w.Event('input'));
    await until(() => w.document.querySelectorAll('#bookmarkList .bookmark-card').length === 12);
    indexed = true;
    messages.emit({ type: 'BOOKMARKS_CHANGED', updatedAt: 100 }, { url: chrome.runtime.getURL('bookmarks.html') }, () => {});
    await until(() => !w.document.querySelector('#bookmarkCount').textContent.includes('remaining'));
    const previousConfig = stored.laterOnBookmarkConfig;
    stored.laterOnBookmarkConfig = { enabled: false, scopeId: null };
    chrome.storage.onChanged.emit({ laterOnBookmarkConfig: { oldValue: previousConfig, newValue: stored.laterOnBookmarkConfig } }, 'local');
    assert.equal(w.document.querySelectorAll('#bookmarkList .bookmark-card').length, 0, 'A metadata-only disable clears the old cards synchronously');
    const disabledConfig = stored.laterOnBookmarkConfig;
    stored.laterOnBookmarkConfig = { enabled: true, scopeId: '1' };
    chrome.storage.onChanged.emit({ laterOnBookmarkConfig: { oldValue: disabledConfig, newValue: stored.laterOnBookmarkConfig } }, 'local');
    assert.equal(w.document.querySelector('#bookmarkEmpty').hidden, true, 'A new scope waits without displaying a false-empty state');
    await until(() => w.document.querySelectorAll('#bookmarkList .bookmark-card').length > 0);
    assert([...w.document.querySelectorAll('#bookmarkList .bookmark-card')].every(card => Number(card.dataset.id.slice(1)) % 2 === 1), 'Only cards inside the new live scope return');
    assert.equal(fullReads, 0);
  } finally { w.close(); }
  console.log('PASS unprepared Bookmarks: bounded native first page and search, live scope/permission, exact URLs, no full mirror and indexed takeover (simulated Chrome/DOM)');
})().catch(error => { console.error(error); process.exitCode = 1; });

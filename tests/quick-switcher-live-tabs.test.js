const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); }, emit(...args) { for (const fn of this.handlers) fn(...args); } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const SHARED = 'https://shared.test/paper?q=kept#section';
function fixture(database = null) {
  const items = Array.from({ length: 260 }, (_, i) => ({ id: `r${i}`, title: `Common paper ${i}`, url: i ? `https://library.test/${i}` : SHARED, savedAt: i + 1 }));
  Object.assign(items[0], { title: 'Reading edited Common', titleEdited: true, projectId: 'project' });
  const store = { laterOnSettings: {}, laterOnBookmarkConfig: { enabled: true, scopeId: null } };
  const native = [{ id: 'bookmark', title: 'BookmarkDistinct Common', url: SHARED }];
  const tabs = [{ id: 1, windowId: 1, url: 'https://source.test/', title: 'Source', lastAccessed: 1 },
    { id: 2, windowId: 2, url: SHARED, title: 'NativeToken Common', lastAccessed: 2000 },
    { id: 3, windowId: 3, url: 'https://standalone.test/', title: 'Common fresh', lastAccessed: 3000 },
    { id: 4, windowId: 3, url: 'chrome://settings/', title: 'Settings', lastAccessed: 1000 }];
  const counts = { queries: 0, builds: 0, indexSearches: 0, indexInfos: 0, writes: [], creates: [], updates: [], notifications: [] };
  let granted = true, holdQuery = null, holdIndex = null;
  const chrome = { runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`, onMessage: event(), onInstalled: event(), onStartup: event(),
    async sendMessage(message) { counts.notifications.push(plain(message)); } },
  storage: { onChanged: event(), local: {
    async get(keys) { return plain(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]]))); },
    async set(value) { counts.writes.push(plain(value)); Object.assign(store, plain(value)); }, async remove(key) { counts.writes.push(key); delete store[key]; } } },
  permissions: { async contains() { return granted; }, onAdded: event(), onRemoved: event() },
  tabs: { onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(), onAttached: event(), onDetached: event(), onActivated: event(),
    async query() { counts.queries++; const value = plain(tabs); if (holdQuery) { const gate = holdQuery; holdQuery = null; await gate; } return value; },
    async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw Error('missing'); return plain(tab); },
    async update(id, value) { counts.updates.push({ id, value: plain(value) }); return { id, ...value }; },
    async create(value) { counts.creates.push(plain(value)); return { id: 100, windowId: 1, ...value }; } },
  windows: { async update() {}, async get(id) { return { id, type: 'normal' }; } },
  bookmarks: { async get(ids) { return (Array.isArray(ids) ? ids : [ids]).map(id => { const value = native.find(node => node.id === id); if (!value || !granted) throw Error('missing'); return plain(value); }); },
    async search({ url }) { return plain(native.filter(node => node.url === url)); } } };
  const context = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout, LaterOnContentMessages: { broadcast() {} } });
  for (const file of ['url-utils.js', 'quick-switcher-modes.js', 'quick-switcher-search.js']) vm.runInContext(read(file), context);
  const engine = context.LaterOnQuickSearch;
  function library(current) { return engine.build({ items, projects: [{ id: 'project', name: 'ProjectMarker' }], sources: current.sources,
    bookmarkConfig: current.bookmarkPermission ? store.laterOnBookmarkConfig : { enabled: false },
    bookmarks: { enabled: true, scopeId: null, nodes: native } }); }
  if (database) {
    context.indexedDB = database;
    context.IDBKeyRange = require('fake-indexeddb').IDBKeyRange;
    Object.assign(store, { laterOnItems: plain(items), laterOnProjects: [{ id: 'project', name: 'ProjectMarker' }],
      laterOnBookmarkSearchState: { enabled: true, scopeId: null, nodes: plain(native) } });
    vm.runInContext(read('local-index.js'), context);
  } else context.LaterOnLocalIndex = { supported: () => true,
    async info() { counts.indexInfos++; return { ready: true, revision: 1, thinBookmarks: true, sourceViews: true }; },
    async putSearchSource() { counts.builds++; throw Error('Unexpected persistent rebuild'); },
    async search(query, current) {
      counts.indexSearches++;
      const entries = library(current), ranked = engine.search(entries, query), wanted = new Set(current.lookupUrls || []);
      const value = { ...ranked, sourcesFiltered: true, bookmarkVariant: current.bookmarkPermission && current.sources.includes('bookmarks'),
        revision: 1, generation: 1, lookupEntries: entries.filter(entry => wanted.has(entry.url)).map(entry => ({ entry, values: engine.fields(entry),
          libraryScore: engine.matchAll([entry], query)[0]?.score ?? null })) };
      if (holdIndex) { const gate = holdIndex; holdIndex = null; await gate; } return value;
    }, async getEntry(id, current) { return library(current).find(entry => entry.id === id) || null; } };
  vm.runInContext(read('quick-switcher-background.js'), context);
  const sender = { url: 'chrome-extension://fixture/library.html', documentId: 'owner' };
  return { chrome, context, tabs, store, counts, native, items,
    search: (query = '', modeId = 'default') => context.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_SEARCH', query, modeId }, sender),
    open: (id, modeId = 'default', newTab = false) => context.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_OPEN', id, modeId, newTab }, sender),
    modes(sources) { const oldValue = plain(store.laterOnSettings); store.laterOnSettings.quickSwitcherModes = context.LaterOnQuickModes.normalize();
      store.laterOnSettings.quickSwitcherModes[0].sources = sources; chrome.storage.onChanged.emit({ laterOnSettings: { oldValue, newValue: plain(store.laterOnSettings) } }, 'local'); },
    revoke() { granted = false; chrome.permissions.onRemoved.emit({ permissions: ['bookmarks'] }); },
    holdTabs() { let release; holdQuery = new Promise(resolve => { release = resolve; }); return release; },
    holdLibrary() { let release; holdIndex = new Promise(resolve => { release = resolve; }); return release; } };
}
function deleteReading(w) {
  const oldValue = plain(w.items), index = w.items.findIndex(item => item.id === 'r0');
  w.items.splice(index, 1); w.store.laterOnItems = plain(w.items);
  w.chrome.storage.onChanged.emit({ laterOnItems: { oldValue, newValue: plain(w.items) } }, 'local');
}
function moveBookmarkScope(w) {
  const oldValue = plain(w.store.laterOnBookmarkConfig);
  w.store.laterOnBookmarkConfig.scopeId = 'missing-scope';
  w.chrome.storage.onChanged.emit({ laterOnBookmarkConfig: { oldValue, newValue: plain(w.store.laterOnBookmarkConfig) } }, 'local');
}
function duringFinalContext(w, change) {
  const get = w.chrome.storage.local.get; let reads = 0;
  w.chrome.storage.local.get = async keys => {
    const snapshot = await get(keys);
    if (Array.isArray(keys) && keys.includes('laterOnSettings') && keys.includes('laterOnBookmarkConfig') && ++reads === 2) change();
    return snapshot;
  };
}
async function finalActionRaces() {
  const arrivals = fixture(), query = arrivals.chrome.tabs.query; let queries = 0;
  arrivals.chrome.tabs.query = async () => {
    const snapshot = await query(), i = ++queries;
    const tab = { id: 50 + i, windowId: 50, url: `https://arriving.test/${i}`, title: 'RareArrival' };
    arrivals.tabs.push(tab); arrivals.chrome.tabs.onCreated.emit(plain(tab)); return snapshot;
  };
  const first = await arrivals.search('RareArrival', 'mode1');
  assert.equal(queries, 1, 'The first native snapshot finishes even if every query triggers another tab event');
  assert.equal(first.total, 1, 'Create events racing the first query are replayed into its snapshot');
  const journal = fixture(), release = journal.holdTabs(), pending = journal.search('', 'mode1'); await tick();
  const closed = journal.tabs.splice(2, 1)[0]; journal.chrome.tabs.onRemoved.emit(closed.id, { windowId: closed.windowId });
  journal.tabs[1].title = 'RenamedDuringSnapshot'; journal.chrome.tabs.onUpdated.emit(2, { title: journal.tabs[1].title }, plain(journal.tabs[1]));
  journal.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 2 }); release();
  const replayed = await pending;
  assert.equal(replayed.total, 3); assert.equal(replayed.results[0].tabIds[0], 2, 'Activation and removal racing the snapshot preserve current ordering and membership');
  assert.equal((await journal.search('RenamedDuringSnapshot', 'mode1')).total, 1);
  const distinct = fixture(), indexSearch = distinct.context.LaterOnLocalIndex.search; let additions = 0;
  distinct.items[1].title = 'RareUnique Library';
  distinct.context.LaterOnLocalIndex.search = async (text, current) => {
    const result = await indexSearch(text, current), i = ++additions;
    const tab = { id: 80 + i, windowId: 80, url: `https://distinct.test/${i}`, title: `RareUnique Native ${i}` };
    distinct.tabs.push(tab); distinct.chrome.tabs.onCreated.emit(plain(tab)); return result;
  };
  const lowerBound = await distinct.search('RareUnique');
  assert.equal(additions, 3); assert.equal(lowerBound.provisional, true);
  assert.equal(lowerBound.results.length, 4); assert.equal(lowerBound.total, 4, 'A provisional union counts proven disjoint library rows and native matches');
  const removed = fixture(); duringFinalContext(removed, () => deleteReading(removed));
  await assert.rejects(removed.open('page:' + SHARED, 'mode2', true), /quickSwitcherMissing/);
  assert.equal(removed.counts.creates.length, 0, 'Reading deleted during the final context cannot create its old page');
  for (const change of ['permission', 'scope']) {
    const book = fixture(), get = book.chrome.bookmarks.get; let gets = 0;
    book.chrome.bookmarks.get = async ids => {
      const snapshot = await get(ids);
      if (++gets === 2) change === 'permission' ? book.revoke() : moveBookmarkScope(book);
      return snapshot;
    };
    await assert.rejects(book.open('page:' + SHARED, 'mode3', true), /quickSwitcherMissing/);
    assert.equal(book.counts.creates.length, 0, `Book ${change} changes during the final native read cannot create a stale page`);
  }
  const navigating = fixture(), tabId = (await navigating.search('NativeToken', 'mode1')).results[0].id;
  const getTab = navigating.chrome.tabs.get; let gets = 0;
  navigating.chrome.tabs.get = async id => {
    const snapshot = await getTab(id);
    if (++gets === 2) {
      const tab = navigating.tabs.find(tab => tab.id === id); tab.pendingUrl = 'https://leaving.test/?q=new#section';
      navigating.chrome.tabs.onUpdated.emit(id, { status: 'loading' }, plain(tab));
    }
    return snapshot;
  };
  await assert.rejects(navigating.open(tabId, 'mode1'), /quickSwitcherMissing/);
  assert.equal(navigating.counts.updates.length, 0, 'Navigation during the final native get cannot activate the stale tab');
  const readingSurvives = fixture(); duringFinalContext(readingSurvives, () => moveBookmarkScope(readingSurvives));
  await readingSurvives.open('page:' + SHARED, 'default', true);
  assert.equal(readingSurvives.counts.creates.at(-1).url, SHARED, 'Current Reading membership remains eligible when Book scope changes');
  const bookmarkSurvives = fixture(); bookmarkSurvives.modes(['reading', 'bookmarks']);
  duringFinalContext(bookmarkSurvives, () => deleteReading(bookmarkSurvives));
  await bookmarkSurvives.open('page:' + SHARED, 'default', true);
  assert.equal(bookmarkSurvives.counts.creates.at(-1).url, SHARED, 'A current selected bookmark remains eligible after Reading deletion');
  const tabSurvives = fixture(); tabSurvives.modes(['tabs', 'reading']);
  duringFinalContext(tabSurvives, () => deleteReading(tabSurvives));
  await tabSurvives.open('page:' + SHARED, 'default', true);
  assert.equal(tabSurvives.counts.creates.length, 0); assert.equal(tabSurvives.counts.updates.at(-1).id, 2, 'The verified exact live tab remains eligible after Reading deletion');
  const lateDelete = fixture(); lateDelete.modes(['tabs', 'reading']);
  const finalGet = lateDelete.chrome.tabs.get; let finalGets = 0;
  lateDelete.chrome.tabs.get = async id => { const snapshot = await finalGet(id); if (++finalGets === 1) deleteReading(lateDelete); return snapshot; };
  await lateDelete.open('page:' + SHARED);
  assert.equal(lateDelete.counts.updates.at(-1).id, 2);
  assert(!lateDelete.counts.writes.some(value => value.laterOnCurrentItem === 'r0'), 'Deletion during the last tab read cannot write the obsolete Reading selection');
  const afterOpen = fixture(), create = afterOpen.chrome.tabs.create;
  afterOpen.chrome.tabs.create = async value => { const tab = await create(value); deleteReading(afterOpen); return tab; };
  await afterOpen.open('page:' + SHARED, 'mode2', true);
  assert.equal(afterOpen.counts.creates.at(-1).url, SHARED);
  assert(!afterOpen.counts.writes.some(value => value.laterOnCurrentItem === 'r0'), 'The deferred selection write skips a Reading item removed while native opening completes');
}
async function main() {
  const w = fixture();
  const all = await w.search('Common');
  assert.equal(all.total, 261, 'A matching tab whose library URL is outside the original top50 counts only once');
  assert.equal(all.results.length, 50); assert(!('lookupEntries' in all), 'Internal URL supplements never leave the worker');
  const cross = await w.search('NativeToken ProjectMarker');
  assert.equal(cross.total, 1, 'Matching can span selected tab and library fields even when neither matches independently');
  assert.equal(cross.results[0].title, 'Reading edited Common');
  assert.deepEqual(plain(cross.results[0].tabIds), [2]); assert.deepEqual(plain(cross.results[0].readingIds), ['r0']);
  assert.deepEqual(plain(cross.results[0].bookmarkIds), ['bookmark']);
  assert.equal((await w.search('Reading edited', 'mode1')).total, 0, 'Tabs-only never matches a library title');
  assert.equal((await w.search('ProjectMarker', 'mode3')).total, 0, 'Book-only never matches a Reading project');
  assert.equal((await w.search('Reading edited', 'mode3')).total, 0, 'Book-only never borrows the edited title');
  const book = await w.search('BookmarkDistinct', 'mode3');
  assert.equal(book.total, 1); assert.equal(book.results[0].title, 'BookmarkDistinct Common'); assert.equal(book.results[0].readingIds.length, 0);
  const combinations = [[['tabs'], 4], [['reading'], 260], [['bookmarks'], 1], [['tabs', 'reading'], 263], [['tabs', 'bookmarks'], 4], [['reading', 'bookmarks'], 260], [['tabs', 'reading', 'bookmarks'], 263]];
  for (const [sources, total] of combinations) {
    w.modes(sources); const response = await w.search(); assert.equal(response.total, total, `Exact total for ${sources}`);
    for (const entry of response.results) {
      if (!sources.includes('tabs')) assert.equal(entry.tabIds?.length || 0, 0);
      if (!sources.includes('reading')) { assert.equal(entry.readingIds.length, 0); assert.equal(entry.projectNames.length, 0); }
      if (!sources.includes('bookmarks')) { assert.equal(entry.bookmarkIds.length, 0); assert.equal(entry.folderNames.length, 0); }
    }
  }
  const before = await w.search('', 'mode1'), nativeQueries = w.counts.queries, infos = w.counts.indexInfos, searches = w.counts.indexSearches;
  w.chrome.tabs.onUpdated.emit(2, { status: 'complete' }, plain(w.tabs[1]));
  assert.equal((await w.search('', 'mode1')).tabGeneration, before.tabGeneration, 'Status-only completion with the same pending URL and searchable fields does not invalidate tabs');
  const added = { id: 5, windowId: 9, url: 'https://new.test/?q=one#two', title: 'CreatedNative', lastAccessed: 9000 };
  w.tabs.push(added); w.chrome.tabs.onCreated.emit(plain(added));
  assert.equal((await w.search('CreatedNative', 'mode1')).total, 1);
  added.title = 'RenamedNative'; w.chrome.tabs.onUpdated.emit(5, { title: added.title }, plain(added));
  assert.equal((await w.search('CreatedNative', 'mode1')).total, 0); assert.equal((await w.search('RenamedNative', 'mode1')).total, 1);
  added.windowId = 2; w.chrome.tabs.onMoved.emit(5, { windowId: 2, toIndex: 4 }); w.chrome.tabs.onActivated.emit({ tabId: 5, windowId: 2 });
  const changed = await w.search('', 'mode1'); assert(changed.tabGeneration > before.tabGeneration);
  w.tabs.splice(w.tabs.indexOf(added), 1); w.chrome.tabs.onRemoved.emit(5, { windowId: 2 });
  assert.equal((await w.search('RenamedNative', 'mode1')).total, 0);
  assert.equal(w.counts.queries, nativeQueries, 'Cached native events update without copying all tabs again');
  assert.equal(w.counts.indexInfos, infos); assert.equal(w.counts.indexSearches, searches, 'Tabs-only does not touch the persistent library');
  assert.equal(w.counts.builds, 0); assert.equal(w.counts.writes.length, 0, 'Tab events and mode settings never write persistent markers or rebuild libraries');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert(w.counts.notifications.some(message => message.change === 'tabs' && Number.isInteger(message.tabGeneration) && !('tabs' in message)), 'Tab updates announce an explicit type and only a small generation');
  const protectedTab = (await w.search('Settings', 'mode1')).results[0];
  await w.open(protectedTab.id, 'mode1', true); assert.equal(w.counts.updates.at(-1).id, 4); assert.equal(w.counts.creates.length, 0);
  const bound = (await w.search('NativeToken', 'mode1')).results[0];
  const target = w.tabs.find(tab => tab.id === 2); target.pendingUrl = 'https://leaving.test/?q=new#section';
  w.chrome.tabs.onUpdated.emit(2, { status: 'loading' }, plain(target));
  await assert.rejects(w.open(bound.id, 'mode1'), /quickSwitcherMissing/, 'A navigation cannot activate the old URL from a tab-only result');
  delete target.pendingUrl; target.url = SHARED;
  const staleId = (await w.search('NativeToken', 'mode1')).results[0].id;
  w.tabs.splice(w.tabs.indexOf(target), 1); w.chrome.tabs.onRemoved.emit(2, { windowId: 2 });
  await assert.rejects(w.open(staleId, 'mode1'), /quickSwitcherMissing/, 'Closing a tab-only result never creates its obsolete page');
  assert.equal(w.counts.creates.length, 0);
  const readEntry = (await w.search('Reading edited', 'mode2')).results[0];
  await w.open(readEntry.id, 'mode2', true); assert.equal(w.counts.creates.at(-1).url, SHARED, 'Library opening keeps the complete query and fragment');
  w.revoke(); await assert.rejects(w.open('page:' + SHARED, 'mode3'), /quickSwitcherMissing/);
  const race = fixture(), releaseTabs = race.holdTabs();
  const oldTabs = race.search('Source', 'mode1'); await tick();
  race.tabs.push({ id: 10, windowId: 10, url: 'https://late.test/', title: 'ArrivedDuringQuery' });
  race.chrome.tabs.onCreated.emit(plain(race.tabs.at(-1))); releaseTabs();
  await oldTabs; assert.equal((await race.search('ArrivedDuringQuery', 'mode1')).total, 1, 'A query snapshot predating a create event cannot replace current tabs');
  const releaseIndex = race.holdLibrary(), oldLibrary = race.search('Common', 'mode2'); await tick();
  await race.search('Settings', 'mode1'); releaseIndex();
  assert.equal((await oldLibrary).cancelled, true, 'A late old mode reply cannot supersede the current query');
  const permissionRace = fixture(), releasePermission = permissionRace.holdLibrary();
  const beforeRevoke = permissionRace.search('BookmarkDistinct', 'mode3'); await tick(); permissionRace.revoke(); releasePermission();
  assert.equal((await beforeRevoke).cancelled, true, 'A reply captured before permission revocation cannot expose the old Bookmarks result');
  const churn = fixture(), originalSearch = churn.context.LaterOnLocalIndex.search;
  let additions = 0;
  churn.context.LaterOnLocalIndex.search = async (query, current) => {
    const result = await originalSearch(query, current);
    const i = ++additions, tab = { id: 20 + i, windowId: 20, url: `https://library.test/${i}`, title: `Common changing ${i}` };
    churn.tabs.push(tab); churn.chrome.tabs.onCreated.emit(plain(tab)); return result;
  };
  const changing = await churn.search('Common');
  assert.equal(additions, 3, 'Continuously arriving URLs use a finite number of snapshot retries');
  assert.equal(changing.provisional, true); assert.equal(changing.total, 261, 'Unverified new overlaps return a lower bound rather than an inflated exact total');
  await finalActionRaces();
  console.log('PASS live tabs: all windows, independent generations/events, seven source combinations, exact out-of-top50 totals, cross-source terms, title isolation, native revalidation and stale-query cancellation');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture };

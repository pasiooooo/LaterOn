const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const event = () => ({ callbacks: [], addListener(fn) { this.callbacks.push(fn); }, emit(...args) { this.callbacks.forEach(fn => fn(...args)); } });
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message, limit = 400) => { for (let i = 0; i < limit && !await check(); i++) await tick(); assert(await check(), message); };
const PENDING = 'laterOnQuickSearchPending';
const db = new IDBFactory();
const source = {
  laterOnItems: [{ id: 'r1', title: 'Saved reading', url: 'https://reading.test/paper?q=x#one', savedAt: 100 }],
  laterOnProjects: [], laterOnBookmarkConfig: { enabled: true, scopeId: null },
  laterOnBookmarkSearchState: { enabled: true, scopeId: null, nodes: [{ id: 'b1', title: 'Bookmark only', url: 'https://book.test/', dateAdded: 200 }] }
};
const local = {};
function worker(database = db, native = null) {
  let granted = true, allowSource = false, gate = null, gated = 0, removeGate = null, removing = 0, blockItems = false;
  const gets = [], changes = event(), removed = event(), messages = [], broadcasts = [], creates = [];
  const tabs = [{ id: 1, windowId: 4, active: true, url: 'https://source.test/' }];
  const chrome = {
    runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`, onMessage: event(), onInstalled: event(), onStartup: event(),
      async sendMessage(message) { messages.push(message); } },
    storage: { onChanged: changes, local: {
      async get(keys) {
        gets.push(plain(keys));
        if (keys === PENDING) return local[PENDING] ? { [PENDING]: plain(local[PENDING]) } : {};
        if (keys === 'laterOnItems') {
          if (blockItems) return new Promise(() => {});
          return { laterOnItems: plain(source.laterOnItems) };
        }
        if (Array.isArray(keys)) {
          const full = keys.includes('laterOnBookmarkSearchState');
          assert(allowSource || !full, 'A restarted worker must not fetch the full source when its prepared index is ready');
          if (full && gate) { const wait = gate; gate = null; gated++; return wait; }
          return plain(Object.fromEntries(keys.filter(key => key in source).map(key => [key, source[key]])));
        }
        assert.equal(keys, 'laterOnBookmarkConfig', 'Prepared queries need only current scope and permission');
        return { laterOnBookmarkConfig: plain(source.laterOnBookmarkConfig) };
      },
      async set(patch) { Object.assign(local, plain(patch)); },
      async remove(key) { removing++; if (removeGate) { const wait = removeGate; removeGate = null; await wait; } delete local[key]; } } },
    permissions: { async contains() { return granted; }, onAdded: event(), onRemoved: removed },
    tabs: { async query() { return plain(tabs); }, async create(value) { creates.push(value); return { id: 50, windowId: 4, ...value }; }, async update() {} },
    windows: { async update() {} },
    bookmarks: native || { async get(id) { if (id === 'b1') return [{ id: 'b1', url: 'https://book.test/' }]; throw Error('missing'); }, async search() { return []; }, async getRecent() { return []; } }
  };
  const context = vm.createContext({ indexedDB: database, IDBKeyRange, chrome, URL, setTimeout, clearTimeout, console,
    LaterOnContentMessages: { broadcast(message) { broadcasts.push(message); } } });
  for (const file of ['url-utils.js', 'quick-switcher-search.js', 'local-index.js', 'quick-switcher-background.js']) vm.runInContext(read(file), context);
  const ext = { url: 'chrome-extension://fixture/library.html' };
  return { store: context.LaterOnLocalIndex, gets, messages, broadcasts, creates,
    installed: () => chrome.runtime.onInstalled.emit({ reason: 'update' }),
    expireActivity: () => vm.runInContext(`Date.now = () => ${Date.now() + 61000}`, context),
    search: query => context.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_SEARCH', query }, ext),
    activeSearch: query => context.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_SEARCH', query, active: true }, { url: 'https://source.test/', tab: { ...tabs[0] } }),
    activity: active => context.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_ACTIVITY', active }, { url: 'https://source.test/', tab: { ...tabs[0] } }),
    open: id => context.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_OPEN', id }, { url: 'https://source.test/', tab: { ...tabs[0] } }),
    revoke() { granted = false; removed.emit({ permissions: ['bookmarks'] }); },
    allow() { allowSource = true; }, hold() { let release; gate = new Promise(resolve => { release = resolve; }); return payload => release(payload); },
    get gated() { return gated; }, get removing() { return removing; },
    blockItems(value = true) { blockItems = value; },
    holdRemove() { let release; removeGate = new Promise(resolve => { release = resolve; }); return () => release(); },
    bookmarkChange(oldValue, newValue) { changes.emit({ laterOnBookmarkSearchState: { oldValue, newValue } }, 'local'); },
    change(oldValue, newValue) { changes.emit({ laterOnItems: { oldValue, newValue } }, 'local'); } };
}
(async () => {
  const first = worker();
  await first.store.putSearchSource(source, 1);
  const restarted = worker();
  assert.equal((await restarted.search('')).total, 2);
  assert.equal((await restarted.search('Bookmark only')).results.length, 1);
  assert(restarted.gets.every(key => key === 'laterOnBookmarkConfig' || key === PENDING), 'Cold worker queries reuse persisted data without large source messages');
  restarted.installed();
  await tick(350);
  assert(restarted.gets.every(key => key === 'laterOnBookmarkConfig' || key === PENDING), 'An installed/update details object does not force an unchanged prepared index to rebuild');
  restarted.blockItems();
  const beforeFreshOpen = restarted.gets.length;
  await Promise.race([
    restarted.open('page:https://reading.test/paper?q=x#one'),
    tick(500).then(() => { throw Error('Opening a current indexed Reading result waited for the full library'); })
  ]);
  assert(!restarted.gets.slice(beforeFreshOpen).includes('laterOnItems'), 'Current indexed Reading membership avoids a full collection read on open');
  assert.equal(restarted.creates.pop().url, 'https://reading.test/paper?q=x#one', 'Fresh opening preserves the full query and fragment');
  restarted.blockItems(false);
  restarted.revoke();
  assert.equal((await restarted.search('')).total, 1);
  assert.equal((await restarted.search('Bookmark only')).total, 0, 'Permission revocation selects Reading immediately without rebuilding');

  const original = plain(source.laterOnItems);
  const status = original.map(entry => ({ ...entry, status: 'done' }));
  restarted.change(original, status);
  const reused = await restarted.search('Saved reading');
  assert.equal(reused.total, 1, 'Status-only changes keep prepared search usable');
  assert.notEqual(reused.provisional, true);

  // A save while the full rebuild is held: the old snapshot plus the live
  // Reading library answer at once, and both old and new pages open.
  restarted.allow();
  const release = restarted.hold();
  const added = [...original, { id: 'r2', title: 'Fresh save', url: 'https://fresh.test/a?b=1#c', savedAt: 300 }];
  source.laterOnItems = added;
  restarted.change(original, added);
  await until(() => restarted.gated === 1, 'The persistent rebuild starts and is held');
  let started = Date.now();
  const during = await restarted.search('Fresh save');
  const elapsed = Date.now() - started;
  assert(elapsed < 500, `A held rebuild does not delay search (${elapsed} ms)`);
  assert.equal(during.provisional, true, 'Results from a stale snapshot are marked provisional');
  assert.equal(during.results[0]?.url, 'https://fresh.test/a?b=1#c', 'A new Reading save is found before indexing commits');
  assert.deepEqual(Array.from(during.results[0].readingIds), ['r2']);
  const old = await restarted.search('Saved reading');
  assert.equal(old.results[0]?.url, 'https://reading.test/paper?q=x#one', 'Existing pages stay searchable during the rebuild');
  started = Date.now();
  assert.equal((await restarted.open(during.results[0].id)).reused, false);
  assert.equal((await restarted.open(old.results[0].id)).reused, false);
  assert(Date.now() - started < 500, 'Opening never waits for the rebuild');
  assert.deepEqual(restarted.creates.map(entry => entry.url), ['https://fresh.test/a?b=1#c', 'https://reading.test/paper?q=x#one']);
  assert(local[PENDING]?.revision > 0, 'The pending source revision is persisted while the rebuild runs');

  // A newer change while the old build is held: the older build cannot commit.
  const renamed = added.map(entry => entry.id === 'r1' ? { ...entry, title: 'Latest title' } : entry);
  source.laterOnItems = renamed;
  restarted.change(added, renamed);
  release({ ...plain(source), laterOnItems: added });
  await until(async () => { const value = await restarted.search('Latest title'); return value.total === 1 && value.provisional !== true; }, 'The newest generation commits and becomes exact');
  assert.equal((await restarted.search('Saved reading')).total, 0, 'The delayed older build did not overwrite the newer state');
  assert.equal((await restarted.search('Fresh save')).provisional, undefined);
  assert(restarted.messages.some(message => message.type === 'LATERON_QUICK_SWITCHER_CHANGED' && message.fresh), 'Extension pages are told when fresh results commit');
  assert(restarted.broadcasts.some(message => message.type === 'LATERON_QUICK_SWITCHER_CHANGED' && message.fresh), 'Web pages are told when fresh results commit');
  assert.equal(local[PENDING], undefined, 'The pending marker clears after the commit');

  // A change that lands while the previous commit is clearing its marker
  // keeps its own marker, so a restart still knows the snapshot is behind.
  const releaseRemove = restarted.holdRemove();
  const removesBefore = restarted.removing;
  const later = [...renamed, { id: 'r4', title: 'Mid clear', url: 'https://mid.test/', savedAt: 350 }];
  source.laterOnItems = later;
  restarted.change(renamed, later);
  await until(() => restarted.removing > removesBefore, 'The next commit starts clearing its marker');
  const newer = [...later, { id: 'r5', title: 'During clear', url: 'https://during.test/', savedAt: 360 }];
  restarted.change(later, newer);
  releaseRemove();
  await tick(20);
  assert(local[PENDING]?.revision > 0, 'The newer change keeps its marker after the older clear finishes');
  source.laterOnItems = renamed;

  // A worker that stopped mid-rebuild finds the marker and repairs while serving.
  local[PENDING] = { revision: Date.now() + 60000 };
  source.laterOnItems = [...renamed, { id: 'r3', title: 'After restart', url: 'https://restart.test/', savedAt: 400 }];
  const repaired = worker(); repaired.allow();
  const early = await repaired.search('After restart');
  assert.equal(early.provisional, true, 'A stale persisted snapshot is detected after restart');
  assert.equal(early.results[0]?.url, 'https://restart.test/');
  assert.equal((await repaired.search('Latest title')).results.length, 1, 'The stale snapshot keeps serving');
  await until(async () => (await repaired.search('After restart')).provisional !== true, 'The restarted worker rebuilds without being asked twice');

  // Native deletion and rename while a changed bookmark source is pending:
  // only the small visible candidate set is revalidated, including on restart.
  local[PENDING] = { revision: Date.now() + 120000, bookmarks: true };
  let nativeTitle = 'Renamed native';
  const bookNodes = [{ id: 'b1', url: 'https://book.test/', title: nativeTitle, dateAdded: 200 }];
  const realNative = {
    async get(id) { const node = bookNodes.find(node => node.id === id); if (!node) throw Error('missing'); return [plain(node)]; },
    async getRecent() { return plain(bookNodes); },
    async search(query) { return plain(bookNodes.filter(node => typeof query === 'string' ? node.title.toLowerCase().includes(query.toLowerCase()) : node.url === query.url)); }
  };
  const bookmarkWorker = worker(db, realNative); bookmarkWorker.allow();
  const holdBookmarks = bookmarkWorker.hold();
  const oldBookSearch = await bookmarkWorker.search('Bookmark only');
  assert.equal(oldBookSearch.provisional, true);
  assert.equal(oldBookSearch.results.length, 0, 'A pending restart validates native titles rather than showing the old title');
  assert.equal((await bookmarkWorker.search('Renamed native')).results[0]?.title, nativeTitle, 'Native rename appears before the changed source is indexed');
  bookNodes.length = 0;
  assert.equal((await bookmarkWorker.search('Bookmark only')).results.length, 0, 'Deleted native ids cannot remain as pending result rows');
  await assert.rejects(bookmarkWorker.open('page:https://book.test/'), /quickSwitcherMissing/);
  await until(() => bookmarkWorker.gated === 1, 'The native changed-source rebuild is held');
  source.laterOnBookmarkSearchState.nodes = [];
  holdBookmarks(plain(source));
  await until(async () => (await bookmarkWorker.search('Latest title')).provisional !== true, 'Changed native source can finish rebuilding');

  // A fresh indexed Reading proof expires synchronously when its source is
  // deleted. A delayed rebuild cannot authorize the stale result.
  const beforeDelete = plain(source.laterOnItems);
  source.laterOnItems = beforeDelete.filter(item => item.id !== 'r1');
  const deletionWorker = worker(); deletionWorker.allow();
  const deletionRelease = deletionWorker.hold();
  deletionWorker.change(beforeDelete, source.laterOnItems);
  await assert.rejects(deletionWorker.open('page:https://reading.test/paper?q=x#one'), /quickSwitcherMissing/, 'Deleted Reading membership is refused while the previous index is still published');
  await until(() => deletionWorker.gated === 1, 'The deleted-source rebuild is held');
  deletionRelease(plain(source));
  await until(async () => (await deletionWorker.search('After restart')).provisional !== true, 'Deletion rebuild settles');

  const paused = worker(); paused.allow();
  await paused.activity(true);
  const pausedRelease = paused.hold();
  const pauseBefore = plain(source.laterOnItems);
  source.laterOnItems = [...pauseBefore, { id: 'paused', title: 'Saved with search open', url: 'https://paused.test/', savedAt: 700 }];
  paused.change(pauseBefore, source.laterOnItems);
  assert.equal((await paused.search('Saved with search open')).results[0]?.url, 'https://paused.test/', 'Interactive search uses the live source without rebuilding');
  await tick(350);
  assert.equal(paused.gated, 0, 'A search dialog pauses the full-source read before it can monopolize the worker');
  await paused.activity(false);
  await until(() => paused.gated === 1, 'Closing the search dialog resumes the delayed build');
  pausedRelease(plain(source));
  await until(async () => (await paused.search('Saved with search open')).provisional !== true, 'Resumed maintenance publishes its new index');
  const cancelled = worker(new IDBFactory()); cancelled.allow();
  const originalPut = cancelled.store.putSearchSource;
  let attempts = 0;
  cancelled.store.putSearchSource = async (input, revision, isCurrent) => {
    if (++attempts === 1) {
      await cancelled.activity(true);
      assert.equal(isCurrent(), false);
      cancelled.expireActivity();
      throw Error('staleLocalIndex');
    }
    return originalPut(input, revision, isCurrent);
  };
  cancelled.change([], source.laterOnItems);
  await until(async () => (await cancelled.store.info())?.ready === true, 'A cancelled build retries after the activity lease expired without a close event');
  assert.equal(attempts, 2, 'The catch-time inactive state never loses the current rebuild');
  const leased = worker(new IDBFactory()); leased.allow();
  const leasedRelease = leased.hold();
  await leased.activeSearch('After restart');
  await tick(350);
  assert.equal(leased.gated, 0, 'An open client query restores activity after a worker restart without another open message');
  leased.expireActivity();
  await until(() => leased.gated === 1, 'An interactive warm timer retries when the lease expires even if no close event arrives');
  leasedRelease(plain(source));
  await until(async () => (await leased.store.info())?.ready === true, 'The retried timer publishes the initially missing index');
  // First use before any index exists: live Reading and scoped native bookmarks.
  const nodes = [{ id: 'root' }, { id: 'scope', parentId: 'root' }, { id: 'n1', parentId: 'scope', title: 'Native inside', url: 'https://inside.test/', dateAdded: 500 },
    { id: 'n2', parentId: 'root', title: 'Native outside', url: 'https://outside.test/', dateAdded: 600 }];
  const native = { async get(id) { const node = nodes.find(entry => entry.id === id); if (!node) throw Error('missing'); return [plain(node)]; },
    async getRecent() { return plain(nodes.filter(node => node.url)); },
    async search(query) { return plain(nodes.filter(node => node.url && (typeof query === 'string' ? node.title.toLowerCase().includes(query.toLowerCase()) : node.url === query.url))); } };
  source.laterOnBookmarkConfig = { enabled: true, scopeId: 'scope' };
  const fresh = worker(new IDBFactory(), native); fresh.allow();
  await fresh.activity(true);
  const firstUse = await fresh.search('');
  assert.equal(firstUse.provisional, true);
  const urls = firstUse.results.map(entry => entry.url);
  assert(urls.includes('https://inside.test/') && urls.includes('https://restart.test/'), 'Unprepared search returns live Reading and native bookmarks');
  assert(!urls.includes('https://outside.test/'), 'Native supplements respect the bookmark scope');
  assert.equal((await fresh.search('native')).results.map(entry => entry.url).join(), 'https://inside.test/');
  assert.equal((await fresh.open('page:https://inside.test/')).reused, false, 'A native-only result opens without an index');
  await until(async () => (await fresh.store.info())?.ready === true, 'Opening a bootstrap result resumes maintenance even if the closing client message is lost');
  await assert.rejects(fresh.open('page:https://outside.test/'), /quickSwitcherMissing/, 'Out-of-scope native pages cannot be opened by id');
  console.log('PASS persistent Quick Switcher worker: no full-source read after restart, permission selection, status reuse, provisional results and opens during a held rebuild, stale-build rejection, fresh notifications and restart repair and unprepared native/Reading bootstrap (simulated IndexedDB)');
})().catch(error => { console.error(error); process.exitCode = 1; });

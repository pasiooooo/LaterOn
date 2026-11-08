// Foreground Quick Switcher recovery while the persistent index is rebuilding:
// queries run on ordinary-priority turns and finish while every
// background-priority task is suspended; the live Reading model is rebuilt
// only when a Reading search field changes, and always from the latest data.
// Fake IndexedDB and a scripted scheduler: behavior only, never Chrome timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const event = () => ({ callbacks: [], addListener(fn) { this.callbacks.push(fn); }, emit(...args) { this.callbacks.forEach(fn => fn(...args)); } });
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message, limit = 600) => { for (let i = 0; i < limit && !await check(); i++) await tick(); assert(await check(), message); };
const within = (promise, ms, message) => Promise.race([promise, tick(ms).then(() => { throw Error(message); })]);
const PENDING = 'laterOnQuickSearchPending';
const SHARED = 'https://shared.test/paper?q=x#one', FRESH = 'https://fresh.test/a?b=1#c', ONLY = 'https://only.test/page?x=1';

// A scheduler whose background queue can be suspended, and whose next
// ordinary-priority task can be held at a known point.
function scheduler() {
  const state = { suspended: false, held: [], counts: { background: 0, 'user-visible': 0 }, gate: null, reached: null };
  state.api = { postTask(callback, { priority = 'user-visible' } = {}) {
    state.counts[priority] = (state.counts[priority] || 0) + 1;
    return new Promise((resolve, reject) => {
      const run = () => { try { resolve(callback()); } catch (error) { reject(error); } };
      if (priority === 'background' && state.suspended) state.held.push(run);
      else if (priority === 'user-visible' && state.gate) { const gate = state.gate; state.gate = null; state.reached(); gate.then(run); }
      else setTimeout(run, 0);
    });
  } };
  state.suspend = () => { state.suspended = true; };
  state.resume = () => { state.suspended = false; for (const run of state.held.splice(0)) setTimeout(run, 0); };
  state.holdVisible = () => {
    let release; state.gate = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { state.reached = resolve; });
    return { reached, release: () => release() };
  };
  return state;
}

function worker() {
  const filler = Array.from({ length: 1200 }, (_, i) => ({ id: `a${i}`, title: `Archive paper ${i}`, url: `https://archive.test/${i}?v=${i}#s`, savedAt: 10 + i }));
  // 150 newer bookmarks keep b1 and b2 out of getRecent(100), as in a large
  // library: their membership must come from the index or a bounded lookup.
  const newer = Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, parentId: '1', title: `Recent link ${i}`, url: `https://recent.test/${i}`, dateAdded: 1000 + i }));
  const native = [{ id: '0', title: '' }, { id: '1', parentId: '0', title: 'Bar' },
    { id: 'b1', parentId: '1', title: 'Bookmark title', url: SHARED, dateAdded: 300 },
    { id: 'b2', parentId: '1', title: 'Bookmark only', url: ONLY, dateAdded: 200 }, ...newer];
  const store = {
    laterOnItems: [{ id: 'r0', title: 'Saved reading', url: SHARED, savedAt: 5000 }, ...filler],
    laterOnProjects: [], laterOnBookmarkConfig: { enabled: true, scopeId: null },
    laterOnSettings: { quickSwitcherModes: [{ id: 'default', prefix: '', sources: ['reading', 'bookmarks'] }] },
    laterOnBookmarkSearchState: { enabled: true, scopeId: null, folders: [{ id: '1', parentId: '0', title: 'Bar' }], nodes: plain(native.slice(1)) }
  };
  const find = id => { const node = native.find(entry => entry.id === id); if (!node) throw Error(`Can't find bookmark for id.`); return plain(node); };
  const changes = event(), messages = [], clock = scheduler(), counts = { recent: 0 };
  const chrome = {
    runtime: { id: 'fixture', getURL: file => `chrome-extension://fixture/${file}`, onMessage: event(), onInstalled: event(), onStartup: event(),
      async sendMessage(message) { messages.push(message); } },
    storage: { onChanged: changes, local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return plain(Object.fromEntries(list.filter(key => key in store).map(key => [key, store[key]])));
      },
      async set(patch) { Object.assign(store, plain(patch)); },
      async remove(key) { delete store[key]; } } },
    permissions: { async contains() { return true; }, onAdded: event(), onRemoved: event() },
    tabs: { async query() { return []; }, onRemoved: event(), onActivated: event() },
    windows: { async update() {} },
    bookmarks: { async get(ids) { return (Array.isArray(ids) ? ids : [ids]).map(find); },
      async getRecent(count) { counts.recent++; return plain(native.filter(node => node.url).sort((a, b) => b.dateAdded - a.dateAdded).slice(0, count)); },
      async search() { return []; }, async getChildren(id) { return plain(native.filter(node => node.parentId === id)); } }
  };
  const context = vm.createContext({ indexedDB: new IDBFactory(), IDBKeyRange, chrome, URL, setTimeout, clearTimeout, console,
    scheduler: clock.api, LaterOnContentMessages: { broadcast() {} } });
  for (const file of ['url-utils.js', 'quick-switcher-modes.js', 'quick-switcher-search.js', 'local-index.js', 'quick-switcher-background.js'])
    vm.runInContext(read(file), context, { filename: file });
  // Live Reading builds are the buildAsync calls made by the worker itself;
  // persistent builds call it from local-index.js.
  const quick = context.LaterOnQuickSearch, buildAsync = quick.buildAsync;
  const builds = [], outcomes = [];
  quick.buildAsync = (input, pause) => {
    const result = buildAsync(input, pause);
    if ((new Error().stack.split('\n')[2] || '').includes('quick-switcher-background.js')) {
      const titles = (input.items || []).filter(item => item.id === 'r0').map(item => item.title);
      builds.push((input.items || []).length);
      result.then(() => outcomes.push({ titles, outcome: 'done' }), error => outcomes.push({ titles, outcome: error?.message }));
    }
    return result;
  };
  const sender = { url: 'chrome-extension://fixture/library.html' };
  return { store, native, messages, clock, builds, outcomes, counts, context, chrome, index: context.LaterOnLocalIndex,
    search: query => context.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_SEARCH', query }, sender),
    // Writes the new values and emits one storage event for all changed keys.
    emit(patch) {
      const change = {};
      for (const [key, value] of Object.entries(patch)) { change[key] = { oldValue: plain(store[key]), newValue: plain(value) }; store[key] = plain(value); }
      changes.emit(change, 'local');
    } };
}
const hit = (result, url) => result.results.find(entry => entry.url === url);
const items = (w, edit) => w.store.laterOnItems.map(item => item.id === 'r0' ? { ...item, ...edit } : item);

(async () => {
  const w = worker();
  await w.index.putSearchSource(plain(w.store), 1);
  const exact = await w.search('Bookmark only');
  assert.notEqual(exact.provisional, true, 'A current prepared index answers exactly');
  assert.deepEqual(plain(hit(exact, ONLY).bookmarkIds), ['b2']);

  // A new save starts a full rebuild; its background turns are then suspended.
  w.clock.suspend();
  w.emit({ laterOnItems: [...w.store.laterOnItems, { id: 'r-new', title: 'Fresh save', url: FRESH, savedAt: 9000 }] });
  await until(() => w.clock.held.length > 0 && !!w.store[PENDING], 'The persistent rebuild starts and waits on a background turn');
  const background = w.clock.counts.background, visible = w.clock.counts['user-visible'], liveBuilds = w.builds.length;
  const started = Date.now();
  const during = await within(w.search('Fresh save'), 1500, 'A foreground query waited for suspended background work');
  const elapsed = Date.now() - started;
  assert(elapsed < 1000, `The foreground query finishes within its bounded recovery path (${elapsed} ms, simulated)`);
  assert.equal(during.provisional, true, 'Results during a rebuild are marked provisional');
  assert.deepEqual(plain(hit(during, FRESH)?.readingIds), ['r-new'], 'The new save is found with its full URL, query and fragment');
  assert.equal(w.builds.length, liveBuilds + 1, 'The live Reading model is built once for the new save');
  assert(w.clock.counts['user-visible'] > visible, 'The live Reading build yields on ordinary-priority turns');
  assert.equal(w.clock.counts.background, background, 'The foreground query never queues behind or joins the background build');
  assert(w.clock.held.length > 0, 'The persistent build is still suspended');
  assert.equal((await w.index.info()).revision, 1, 'The old snapshot stays published while the rebuild waits');
  const old = await within(w.search('Bookmark only'), 1500, 'A bookmark query waited for the rebuild');
  assert.deepEqual(plain(hit(old, ONLY)?.bookmarkIds), ['b2'], 'Bookmarks from the last ready snapshot remain searchable');
  assert.equal(w.builds.length, liveBuilds + 1, 'A second query reuses the live Reading model');

  // The bulk build keeps its background priority and finishes once resumed.
  w.clock.resume();
  await until(async () => (await w.index.info())?.revision > 1 && w.messages.some(message => message.fresh), 'The resumed rebuild publishes and announces a fresh index');
  const fresh = await w.search('Fresh save');
  assert.notEqual(fresh.provisional, true, 'After the commit, the exact index answers');
  assert.deepEqual(plain(hit(fresh, FRESH).readingIds), ['r-new']);

  // Status-only and bookmark-only changes keep the live Reading model.
  const steady = w.builds.length;
  w.emit({ laterOnItems: w.store.laterOnItems.map(item => ({ ...item, status: 'done' })) });
  assert.notEqual((await w.search('Fresh save')).provisional, true, 'A status-only change does not invalidate the prepared index');
  w.emit({ laterOnBookmarkSearchState: { ...w.store.laterOnBookmarkSearchState, folders: [...w.store.laterOnBookmarkSearchState.folders] } });
  const bookOnly = await w.search('Fresh save');
  assert.equal(bookOnly.provisional, true, 'A bookmark-only change makes results provisional until the next commit');
  assert.deepEqual(plain(hit(bookOnly, FRESH)?.readingIds), ['r-new']);
  assert.equal(w.builds.length, steady, 'Status-only and bookmark-only changes do not rebuild the live Reading model');

  // One storage event carrying a Reading title edit and a bookmark change.
  w.emit({ laterOnItems: items(w, { title: 'My edited title', titleEdited: true }),
    laterOnBookmarkSearchState: { ...w.store.laterOnBookmarkSearchState } });
  const mixed = await within(w.search('My edited'), 1500, 'A mixed change waited for the rebuild');
  const shared = hit(mixed, SHARED);
  assert(shared, 'A mixed storage event rebuilds the live Reading model from the new title');
  assert.equal(w.builds.length, steady + 1, 'A mixed event rebuilds the live Reading model once');
  assert.equal(shared.title, 'My edited title', 'An edited Reading title takes precedence over the bookmark title');
  assert.deepEqual(plain(shared.readingIds), ['r0'], 'The shared URL keeps its Reading membership');
  assert.deepEqual(plain(shared.bookmarkIds), ['b1'], 'The shared URL keeps its live-verified bookmark membership');

  // A Reading change arriving while the live model is being built cancels
  // the old source reply. The ensuing client refresh uses the newest data.
  w.clock.suspend();
  await tick(20);
  w.emit({ laterOnItems: items(w, { title: 'Version one', titleEdited: true }) });
  const holding = w.clock.holdVisible();
  const racing = w.search('Version');
  await within(holding.reached, 1500, 'The live Reading build reaches an ordinary-priority turn');
  w.emit({ laterOnItems: items(w, { title: 'Version two', titleEdited: true }) });
  holding.release();
  const cancelled = await within(racing, 1500, 'A query whose live Reading model changed mid-build did not finish');
  assert.equal(cancelled.cancelled, true, 'A reply from an older source generation is cancelled');
  assert.equal(cancelled.results.length, 0, 'The cancelled source reply exposes no stale rows');
  const latest = await within(w.search('Version'), 1500, 'The refreshed query did not finish from the newest Reading model');
  assert.equal(hit(latest, SHARED)?.title, 'Version two', 'The query answers from the Reading data current when it finished');
  assert(!latest.results.some(entry => entry.title === 'Version one'), 'The superseded model is never returned');
  assert.deepEqual(plain(hit(latest, SHARED).bookmarkIds), ['b1']);
  assert.equal(w.builds.at(-1), w.store.laterOnItems.length, 'The last live build used the newest Reading library');
  await until(() => w.outcomes.some(entry => entry.titles[0] === 'Version two'), 'The newest live build settles');
  assert.deepEqual(w.outcomes.filter(entry => entry.titles[0] === 'Version one').map(entry => entry.outcome), ['staleReadingSource'],
    'The superseded live build stops at its next turn instead of finishing the old library');
  assert.deepEqual(w.outcomes.filter(entry => entry.titles[0] === 'Version two').map(entry => entry.outcome), ['done']);
  w.clock.resume();

  // A Reading-only title edit on a shared URL, with no bookmark change at all:
  // the new title is not in the old snapshot, the bookmark membership still is.
  const clean = worker();
  await clean.index.putSearchSource(plain(clean.store), 1);
  clean.clock.suspend();
  clean.emit({ laterOnItems: items(clean, { title: 'Reading only edit', titleEdited: true }) });
  const edited = hit(await within(clean.search('Reading only edit'), 1500, 'A Reading-only edit waited for the rebuild'), SHARED);
  assert.equal(edited?.title, 'Reading only edit');
  assert.deepEqual(plain(edited.readingIds), ['r0']);
  assert.deepEqual(plain(edited.bookmarkIds), ['b1'], 'A Reading-only edit keeps the bookmark membership of a shared URL');
  clean.clock.resume();
  // A Reading edit arriving in the same event as a legacy full bookmark
  // mirror (thin mirror not yet known): bookmarks are re-verified live too.
  const legacy = worker();
  const { laterOnBookmarkSearchState: thin, ...legacySource } = plain(legacy.store);
  legacy.store.laterOnBookmarkState = thin; delete legacy.store.laterOnBookmarkSearchState;
  await legacy.index.putSearchSource({ ...legacySource, laterOnBookmarkState: thin }, 1);
  legacy.clock.suspend();
  const recentBefore = legacy.counts.recent;
  legacy.emit({ laterOnItems: items(legacy, { title: 'Legacy edit', titleEdited: true }), laterOnBookmarkState: { ...thin } });
  const legacyHit = hit(await within(legacy.search('Legacy edit'), 1500, 'A mixed legacy event waited for the rebuild'), SHARED);
  assert.equal(legacyHit?.title, 'Legacy edit');
  assert(legacy.counts.recent > recentBefore, 'A legacy bookmark mirror change in a Reading event re-verifies native bookmarks');
  legacy.clock.resume();

  // Pure background start: no Search index and a bookmark source that is not
  // ready yet. When the source becomes ready, bookmark sync's notification
  // alone must finish the build and clear the durable marker.
  const cold = worker();
  let sourceReady = false;
  const bookmarkSource = plain(cold.store.laterOnBookmarkSearchState);
  cold.context.LaterOnBookmarkSync = { async searchSource() { return sourceReady ? plain(bookmarkSource) : null; } };
  const searches = [];
  const handle = cold.context.LaterOnQuickSwitcher.handle;
  cold.context.LaterOnQuickSwitcher.handle = (message, sender) => { searches.push(message.type); return handle(message, sender); };
  cold.chrome.runtime.onInstalled.emit({ reason: 'update' });
  await until(() => !!cold.store[PENDING], 'The first warm-up decides a build is needed and records its marker');
  await tick(400);
  assert.notEqual((await cold.index.info())?.ready, true, 'Without a ready bookmark source the first build publishes nothing');
  sourceReady = true;
  cold.context.LaterOnQuickSwitcher.bookmarksReady();
  await until(async () => (await cold.index.info())?.ready === true && !cold.store[PENDING], 'A bookmark-ready notification finishes the build and clears the marker');
  const coldMeta = await cold.index.info();
  assert.equal(coldMeta.bookmarkEnabled, true, 'The finished build includes bookmarks');
  assert.deepEqual(searches, [], 'No Quick search or forced rebuild was needed');
  assert(cold.messages.some(message => message.fresh), 'The finished build is announced');

  console.log('PASS quick-switcher foreground: queries finish while background turns are suspended, bulk work stays background, status-only/bookmark-only changes keep the live Reading model, mixed and mid-build Reading changes answer from the newest edited title with Reading and bookmark membership (simulated scheduler and IndexedDB)');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });

// Dense Quick postings are left out of the index and recorded in metadata; a
// query treats those terms as "no filter" and the exact verification decides.
// Results must equal the in-memory search and a snapshot with every posting.
// Fake IndexedDB proves behavior and row counts, never Chrome timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange, IDBObjectStore, IDBDatabase } = require('fake-indexeddb');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const THRESHOLD = 'DENSE_POSTING_MIN = 2048';

function host(factory, { everyPosting = false, globals = {} } = {}) {
  const context = vm.createContext({ indexedDB: factory, IDBKeyRange, URL, setTimeout, clearTimeout, ...globals });
  for (const file of ['url-utils.js', 'quick-switcher-search.js', 'local-index.js']) {
    let code = fs.readFileSync(path.join(root, file), 'utf8');
    if (file === 'local-index.js') {
      assert(code.includes(THRESHOLD), 'The fixture knows the production threshold');
      if (everyPosting) code = code.replace(THRESHOLD, 'DENSE_POSTING_MIN = 1e9');
    }
    vm.runInContext(code, context, { filename: file });
  }
  return { store: context.LaterOnLocalIndex, engine: context.LaterOnQuickSearch };
}
async function all(factory, storeName) {
  const db = await new Promise((resolve, reject) => { const r = factory.open('lateron-local-index-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const rows = await new Promise((resolve, reject) => { const r = db.transaction(storeName).objectStore(storeName).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  db.close();
  return rows;
}
async function editSearchMeta(factory, edit) {
  const db = await new Promise((resolve, reject) => { const r = factory.open('lateron-local-index-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('searchMeta', 'readwrite'), store = tx.objectStore('searchMeta'), read = store.get('search');
    read.onsuccess = () => store.put(edit(read.result));
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const config = { enabled: true, scopeId: null };
const permitted = { bookmarkConfig: config, bookmarkPermission: true };
const revoked = { ...permitted, bookmarkPermission: false };
let seed = 0x51ab1e;
const random = limit => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 2 ** 32 * limit); };
const pick = list => list[random(list.length)];
const words = ['obsidian', 'kepler', 'protocol', 'review', 'dataset', 'harbor', 'zephyr', 'lumen', '机器学习', '科研资料', '量子计算', 'résumé'];
const large = {
  laterOnItems: Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}`, title: `Obsidian ${pick(words)} ${pick(words)} ${i}`,
    url: `https://read${i % 7}.example.test/${pick(words)}/${i}?ref=saved&n=${i}#part-${i % 5}`, savedAt: 1000 + (i * 37) % 4000, projectId: i % 3 ? null : 'p' })),
  laterOnProjects: [{ id: 'p', name: '博士研究' }], laterOnBookmarkConfig: config,
  laterOnBookmarkSearchState: { enabled: true, scopeId: null, folders: [{ id: '1', parentId: '0', title: '书签栏' }],
    nodes: [{ id: '1', parentId: '0', title: '书签栏' }, ...Array.from({ length: 3500 }, (_, i) => ({ id: `b${i}`, parentId: '1',
      title: `Bookmark ${pick(words)} ${i}`, url: `https://book${i % 11}.example.test/${pick(words)}/${i}?q=${i}#anchor`, dateAdded: 50 + i }))] }
};
const buildInput = (source, bookmarks = true) => ({ items: source.laterOnItems, projects: source.laterOnProjects,
  ...(bookmarks ? { bookmarks: source.laterOnBookmarkSearchState, bookmarkConfig: config } : {}) });

function queries() {
  // Fixed cases: each exercises one way an omitted term can meet a stored one.
  const fixed = ['', 'e', 'o', 'ob', '量', '机器', 'obs', 'http', 'example', 'obsidian', 'obsidian 4999', 'example 4999', 'saved 量子',
    // A sparse literal stored next to a dense one, and the reverse.
    'ref=saved&n=4321', '4321#part', 'bookmark 3499',
    // Fuzzy only: the literal grams do not occur, every letter is omitted.
    'obsdn', 'obsdian', 'kplr', 'prtcl',
    // Both sides empty or absent.
    'zzzzq', '不存在的词', 'obsidian zzzzq', 'résumé', 'resume', 'RÉSUMÉ', '博士研究', '等待整理'];
  const titles = large.laterOnItems.map(item => item.title).concat(large.laterOnBookmarkSearchState.nodes.filter(node => node.url).map(node => node.title));
  const urls = large.laterOnItems.map(item => item.url);
  const generated = [];
  for (let i = 0; i < 90; i++) {
    const text = pick(i % 2 ? titles : urls), start = random(Math.max(1, text.length - 8));
    generated.push(text.slice(start, start + 1 + random(8)).trim());
    const word = pick(words);
    generated.push([...word].filter(() => random(4) > 0).join(''));
    generated.push(`${pick(words)} ${pick(words)}`);
  }
  return [...new Set([...fixed, ...generated])];
}

async function capping() {
  const factory = new IDBFactory(), capped = host(factory);
  await capped.store.putSearchSource(large, 5);
  const meta = await capped.store.info('search');
  assert(meta.omittedPostings.length > 0, 'A large library omits its dense lists');
  assert(meta.omittedPostings.some(key => key.startsWith('r:')) && meta.omittedPostings.some(key => key.startsWith('a:')), 'Each variant has its own threshold');
  assert.equal(meta.postingStats.r.limit, 2048, 'A variant below 5x the minimum uses the minimum');
  assert.equal(meta.postingStats.a.limit, 2048);
  const rows = await all(factory, 'postings'), stored = new Set(rows.map(row => row.key));
  assert(rows.every(row => row.positions.length <= 2048), 'No stored list exceeds its variant threshold');
  assert(meta.omittedPostings.every(key => !stored.has(key)), 'An omitted list has no stored rows');
  for (const kind of ['r', 'a']) {
    const mine = rows.filter(row => row.key[0] === kind), counts = meta.postingStats[kind];
    assert.equal(counts.keys, mine.length, 'Stored key statistics are exact');
    assert.equal(counts.positions, mine.reduce((sum, row) => sum + row.positions.length, 0), 'Stored position statistics are exact');
  }

  // A snapshot with every posting and no omission metadata: what SCHEMA 5
  // databases published before this change hold.
  const oldFactory = new IDBFactory(), legacy = host(oldFactory, { everyPosting: true });
  await legacy.store.putSearchSource(large, 5);
  await editSearchMeta(oldFactory, ({ omittedPostings, postingStats, ...meta }) => meta);
  const oldMeta = await legacy.store.info('search');
  assert.equal(oldMeta.omittedPostings, undefined);
  const oldRows = await all(oldFactory, 'postings');
  assert(oldRows.some(row => row.positions.length > 2048), 'The older snapshot stores dense lists');
  const oldPositions = oldRows.reduce((sum, row) => sum + row.positions.length, 0);
  const newPositions = rows.reduce((sum, row) => sum + row.positions.length, 0);
  assert.equal(meta.postingStats.r.positions + meta.postingStats.r.omittedPositions + meta.postingStats.a.positions + meta.postingStats.a.omittedPositions, oldPositions,
    'Stored plus omitted positions equal the full index');
  assert(newPositions < oldPositions / 2, `Capping removes most positions (${oldPositions} -> ${newPositions})`);
  const reader = host(oldFactory);
  const combined = capped.engine.build(buildInput(large)), reading = capped.engine.build(buildInput(large, false));
  for (const query of queries()) {
    for (const [context, index, name] of [[permitted, combined, 'combined'], [revoked, reading, 'Reading only']]) {
      const expected = plain(capped.engine.search(index, query, { limit: 30 }));
      const actual = await capped.store.search(query, context, { limit: 30 });
      assert.deepEqual(plain({ results: actual.results, total: actual.total }), expected, `${name} parity with omitted lists: ${JSON.stringify(query)}`);
      const old = await reader.store.search(query, context, { limit: 30 });
      assert.deepEqual(plain({ results: old.results, total: old.total }), expected, `${name} parity on an older snapshot: ${JSON.stringify(query)}`);
    }
  }
  const fuzzy = await capped.store.search('obsdn', permitted, { limit: 30 });
  assert(fuzzy.total >= 5000, 'A fuzzy-only match survives when every fuzzy letter was omitted: all Reading titles contain Obsidian');

  // An unfiltered query still clones only light columns and visible winners.
  const originalGetAll = IDBObjectStore.prototype.getAll, originalGet = IDBObjectStore.prototype.get;
  let recordScans = 0, recordGets = 0;
  IDBObjectStore.prototype.getAll = function (...args) { if (this.name === 'records') recordScans++; return originalGetAll.apply(this, args); };
  IDBObjectStore.prototype.get = function (...args) { if (this.name === 'records') recordGets++; return originalGet.apply(this, args); };
  try {
    for (const query of ['e', 'obsidian', 'obsdn', 'obsidian 4999']) {
      recordGets = 0;
      const result = await capped.store.search(query, permitted, { limit: 25 });
      assert(result.results.length <= 25);
      assert(recordGets <= 50, `${query}: only the visible winners are hydrated (${recordGets})`);
    }
    assert.equal(recordScans, 0, 'Non-empty queries never scan complete records');
  } finally { IDBObjectStore.prototype.getAll = originalGetAll; IDBObjectStore.prototype.get = originalGet; }

  // Below the minimum nothing is omitted, however common a term is.
  const smallFactory = new IDBFactory(), small = host(smallFactory);
  const few = { laterOnItems: large.laterOnItems.slice(0, 2000), laterOnProjects: large.laterOnProjects };
  await small.store.putSearchSource(few, 1);
  assert.deepEqual(plain((await small.store.info('search')).omittedPostings), [], 'A small library keeps every list');
  const smallIndex = small.engine.build({ items: few.laterOnItems, projects: few.laterOnProjects });
  for (const query of ['e', 'obsidian', 'obsdn', '量子']) {
    const actual = await small.store.search(query, revoked);
    assert.deepEqual(plain({ results: actual.results, total: actual.total }), plain(small.engine.search(smallIndex, query)), `Small library parity: ${query}`);
  }
  // An empty library answers without reading a posting or a block.
  const emptyFactory = new IDBFactory(), empty = host(emptyFactory);
  await empty.store.putSearchSource({ laterOnItems: [], laterOnProjects: [] }, 1);
  assert.deepEqual(plain(await empty.store.search('obsidian', revoked)), { results: [], total: 0, persistent: true, revision: 1, bookmarkVariant: false });
  return { oldPositions, newPositions };
}

async function writesAndCancellation() {
  const counted = hostWithCounts();
  const quick = counted.engine, original = quick.yieldTask;
  let yields = 0;
  quick.yieldTask = () => { yields++; return original(); };
  counted.onFirstData = () => { yields = 0; };
  await counted.store.putSearchSource(large, 1);
  assert(counted.dataWrites() >= 10, 'The search build writes many chunks');
  assert.equal(yields, 0, 'Search chunks rely on transaction completion instead of a second scheduled yield');
  await counted.store.idle();
  counted.reset();
  await counted.store.putBookmarkState(bookmarkState(3000, 100));
  assert(counted.dataWrites() >= 5, 'The bookmark build writes many chunks');
  assert.equal(yields, 0, 'Bookmark chunks rely on transaction completion instead of a second scheduled yield');
  await counted.store.idle();

  // Removing yields must not remove cancellation: a build stops at the next chunk.
  const before = await counted.store.info('search');
  counted.reset();
  let current = true;
  counted.onFirstData = () => { current = false; };
  await assert.rejects(counted.store.putSearchSource(large, 2, () => current), /staleLocalIndex/, 'A cancelled source stops between chunks');
  assert.equal(counted.dataWrites(), 1, 'No further chunk is written after cancellation');
  assert.equal((await counted.store.info('search')).generation, before.generation);
  assert.equal((await counted.store.info('search')).pending, null);
  const beforeBooks = await counted.store.info('bookmarks');
  counted.reset();
  current = true;
  counted.onFirstData = () => { current = false; };
  await assert.rejects(counted.store.putBookmarkState(bookmarkState(3000, 200), { isCurrent: () => current }), /staleLocalIndex/);
  assert.equal(counted.dataWrites(), 1, 'A cancelled bookmark build stops between chunks');
  assert.equal((await counted.store.info('bookmarks')).generation, beforeBooks.generation);
}
const bookmarkState = (count, updatedAt) => ({ enabled: true, scopeId: null, updatedAt, folders: [{ id: '1', parentId: '0', title: 'Bar' }],
  nodes: [{ id: '1', parentId: '0', title: 'Bar' }, ...Array.from({ length: count }, (_, i) => ({ id: `n${i}`, parentId: '1', title: `page ${i}`, url: `https://n.test/${i}`, dateAdded: 10 + i }))] });
function hostWithCounts() {
  const dataStores = new Set(['records', 'postings', 'searchQueries', 'bookmarkNodes', 'bookmarkTerms', 'bookmarkQueries', 'bookmarkTermExtras']);
  const state = { writes: 0 }, open = IDBDatabase.prototype.transaction;
  const factory = new IDBFactory(), made = host(factory), result = { ...made, onFirstData: null, dataWrites: () => state.writes, reset() { state.writes = 0; } };
  IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
    const tx = open.call(this, stores, mode, ...rest);
    if (mode === 'readwrite' && dataStores.has([].concat(stores)[0])) {
      let wrote = false;
      const put = tx.objectStore.bind(tx);
      tx.objectStore = name => { const store = put(name), write = store.put.bind(store); store.put = (...args) => { wrote = true; return write(...args); }; return store; };
      tx.addEventListener('complete', () => { if (wrote && ++state.writes === 1) result.onFirstData?.(); });
    }
    return tx;
  };
  return result;
}

async function keepAlive() {
  // Only the keep-alive delay is captured; every other timer behaves normally.
  const timers = new Set();
  const timer = (callback, delay, ...rest) => {
    if (delay !== 20000) return setTimeout(callback, delay, ...rest);
    const entry = { callback }; timers.add(entry); return entry;
  };
  const clear = value => { if (timers.has(value)) timers.delete(value); else clearTimeout(value); };
  const fire = () => { const [entry] = timers; assert(entry, 'A keep-alive timer is pending'); timers.delete(entry); entry.callback(); };
  let pings = 0, failure = null;
  const runtime = { getPlatformInfo() { pings++; if (failure === 'throw') throw Error('unavailable'); return failure === 'reject' ? Promise.reject(Error('unavailable')) : Promise.resolve({ os: 'mac' }); } };
  const made = host(new IDBFactory(), { globals: { setTimeout: timer, clearTimeout: clear, chrome: { runtime } } });
  const quick = made.engine;
  let openPrep, reached;
  const hold = () => {
    const opened = new Promise(resolve => { openPrep = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
    quick.yieldTask = () => { reached(); return opened; };
    return arrived;
  };
  const releasePrep = () => { quick.yieldTask = () => Promise.resolve(); openPrep(); };

  // Bookmark CPU preparation, before any IndexedDB write, is covered.
  let arrived = hold();
  const books = made.store.putBookmarkState(bookmarkState(600, 100));
  await arrived;
  assert.equal(pings, 1, 'A build pings at once: a delayed start may already be close to the idle limit');
  assert.equal(timers.size, 1);
  fire();
  assert.equal(pings, 2, 'Each interval pings again');
  assert.equal(timers.size, 1, 'An active build keeps exactly one timer');
  // A second concurrent build shares the timer and outlives the first.
  const second = made.store.putSearchSource({ laterOnItems: large.laterOnItems.slice(0, 600), laterOnProjects: [] }, 3);
  assert.equal(pings, 2);
  assert.equal(timers.size, 1, 'Concurrent builds share one timer');
  failure = 'reject'; fire(); assert.equal(timers.size, 1, 'A rejected call keeps the build and its timer alive');
  failure = 'throw'; fire(); assert.equal(timers.size, 1, 'A throwing call keeps the build and its timer alive');
  failure = null;
  releasePrep();
  await Promise.all([books, second]);
  await made.store.idle();
  assert.equal(timers.size, 0, 'No timer remains after the last build');
  assert.equal((await made.store.info('bookmarks')).ready, true);
  assert.equal((await made.store.info('search')).ready, true, 'Keep-alive failures never damage the index');

  // A cancelled build stops its timer too, and the source read is covered.
  const stopped = pings;
  arrived = hold();
  const cancelled = made.store.putSearchSource({ laterOnItems: large.laterOnItems.slice(0, 600), laterOnProjects: [] }, 4, () => false);
  await assert.rejects(cancelled, /staleLocalIndex/);
  await made.store.idle();
  assert.equal(pings, stopped + 1);
  assert.equal(timers.size, 0, 'A cancelled build leaves no timer');
  releasePrep();
  const read = made.store.bookmarkSearchSource();
  assert.equal(pings, stopped + 2, 'A long bookmark source read is also kept alive');
  await read;
  assert.equal(timers.size, 0);

  // Without the extension API a build simply runs.
  const bare = host(new IDBFactory(), { globals: { chrome: {} } });
  await bare.store.putBookmarkState(bookmarkState(10, 100));
  assert.equal((await bare.store.info('bookmarks')).ready, true);
}

(async () => {
  const volume = await capping();
  await writesAndCancellation();
  await keepAlive();
  console.log(`PASS local index dense postings: exact parity with omitted lists and older snapshots across CJK/fuzzy/empty/random queries, visible-only hydration, no second yield between chunks, cancellation and build-only keep-alive (positions ${volume.oldPositions} -> ${volume.newPositions}; simulated IndexedDB)`);
})().catch(error => { console.error(error); process.exitCode = 1; });

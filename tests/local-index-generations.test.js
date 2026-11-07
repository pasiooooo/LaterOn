// Generation-tagged snapshots: a rebuild writes a new generation in short
// transactions while the published one keeps serving, publishes with one small
// metadata write, and removes superseded rows later. Instrumented fake
// IndexedDB counts requests per transaction; it says nothing about Chrome timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fake = require('fake-indexeddb');
const { IDBFactory, IDBKeyRange, IDBObjectStore, IDBDatabase } = fake;
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));

// Per-transaction accounting of writes, plus a log of record hydration.
const stats = new WeakMap(), writes = [], owners = new WeakMap();
let recordGets = 0, failStore = null;
const openTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
  const tx = openTransaction.call(this, stores, mode, ...rest);
  if (mode === 'readwrite') {
    const entry = { stores: [].concat(stores), puts: 0, deletes: 0 }, owner = owners.get(this);
    stats.set(tx, entry); writes.push(entry);
    // Writers do not yield between chunks, so a hold delays the moment the
    // writer learns its chunk committed: that chunk is durable, the next one
    // has not begun. Only the holding worker's transactions wait.
    let complete = null;
    Object.defineProperty(tx, 'oncomplete', { configurable: true, set(value) { complete = value; }, get() {
      return complete && (event => { const wait = owner?.gate?.(entry); if (wait) wait.then(() => complete(event)); else complete(event); });
    } });
  }
  return tx;
};
for (const [name, field] of [['put', 'puts'], ['delete', 'deletes']]) {
  const original = IDBObjectStore.prototype[name];
  IDBObjectStore.prototype[name] = function (...args) {
    if (name === 'put' && failStore === this.name) throw Error('injected write failure');
    const entry = stats.get(this.transaction); if (entry) entry[field]++; return original.apply(this, args);
  };
}
const originalGet = IDBObjectStore.prototype.get;
IDBObjectStore.prototype.get = function (...args) { if (this.name === 'records') recordGets++; return originalGet.apply(this, args); };

function host(factory) {
  const owner = { gate: null };
  const indexedDB = { open(...args) {
    const opening = factory.open(...args);
    opening.addEventListener('success', () => owners.set(opening.result, owner));
    return opening;
  } };
  const context = vm.createContext({ indexedDB, IDBKeyRange, URL, setTimeout, clearTimeout });
  for (const file of ['url-utils.js', 'quick-switcher-search.js', 'local-index.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return { store: context.LaterOnLocalIndex, engine: context.LaterOnQuickSearch, hold(after = entry => !entry.stores.some(name => name.endsWith('Meta'))) {
    let open, reached;
    const opened = new Promise(resolve => { open = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
    // Hold once this build has written data rows (after its claim); a
    // background sweep only deletes and does not count.
    owner.gate = entry => { if (entry.puts > 0 && after(entry)) { reached(); return opened; } return null; };
    return { reached: arrived, release() { owner.gate = null; open(); } };
  } };
}
async function rows(factory, storeName) {
  const db = await new Promise((resolve, reject) => { const r = factory.open('lateron-local-index-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const keys = await new Promise((resolve, reject) => { const r = db.transaction(storeName).objectStore(storeName).getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  db.close();
  return keys.map(key => key[0]);
}
const generationsIn = keys => [...new Set(keys)].sort((a, b) => a - b);
const config = { enabled: true, scopeId: null }, allowed = { bookmarkConfig: config, bookmarkPermission: true };
const sourceWith = (count, word) => ({
  laterOnItems: Array.from({ length: count }, (_, i) => ({ id: `r${i}`, url: `https://read.test/${i}?v=${word}#s${i % 3}`,
    title: `${i % 10 === 0 ? 'Rarely ' : ''}${word} 阅读 ${i}`, savedAt: 1000 + i, projectId: i % 4 ? null : 'p' })),
  laterOnProjects: [{ id: 'p', name: '项目' }], laterOnBookmarkConfig: config,
  laterOnBookmarkSearchState: { enabled: true, scopeId: null, nodes: Array.from({ length: 400 }, (_, i) => ({ id: `b${i}`, parentId: '1', title: `${word} bookmark ${i}`,
    url: `https://book.test/${i}`, dateAdded: 50 + i })) } });
const bookmarks = (count, updatedAt, word) => {
  const folders = [{ id: '1', parentId: '0', title: 'Bar' }, { id: 'f', parentId: '1', title: 'Folder' }];
  return { enabled: true, scopeId: null, updatedAt, folders, nodes: [...folders, ...Array.from({ length: count }, (_, i) => ({ id: `n${i}`,
    parentId: i % 2 ? 'f' : '1', title: `${word} page ${i}`, url: `https://n.test/${i}?q=${i}#h`, dateAdded: 10 + i }))] };
};

(async () => {
  const factory = new IDBFactory(), one = host(factory), two = host(factory);
  const old = sourceWith(3000, 'alpha'), next = sourceWith(3000, 'omega');
  await one.store.putSearchSource(old, 10);
  const first = await one.store.info('search');
  assert.equal(first.ready, true); assert.equal(first.revision, 10); assert.equal(first.pending, null);

  // Every write transaction is short: one data store and a bounded number of rows.
  const fullWrites = writes.filter(entry => entry.stores.some(name => ['records', 'postings', 'searchQueries'].includes(name)));
  assert(fullWrites.length >= 10, 'A large source is written in many transactions');
  assert(fullWrites.every(entry => entry.stores.length === 1 && entry.puts <= 500), `No data transaction exceeds 500 rows (max ${Math.max(...fullWrites.map(entry => entry.puts))})`);

  // Reads during a held rebuild use the published generation and see no partial rows.
  const expectOld = one.engine.build({ items: old.laterOnItems, projects: old.laterOnProjects, bookmarks: old.laterOnBookmarkSearchState, bookmarkConfig: config });
  const held = one.hold();
  const building = one.store.putSearchSource(next, 11);
  await held.reached;
  const during = await two.store.info('search');
  assert.equal(during.ready, true, 'Ready stays true while a rebuild writes');
  assert.equal(during.generation, first.generation);
  assert.equal(during.pending.revision, 11);
  for (const query of ['', 'alpha', 'omega', 'rarely alpha', '阅读 5']) {
    const result = await two.store.search(query, allowed);
    assert.deepEqual(plain({ results: result.results, total: result.total }), plain(one.engine.search(expectOld, query)), `Old snapshot served during rebuild: ${query}`);
    assert.equal(result.pending, true, 'Readers learn that a newer revision is being prepared');
  }
  assert(generationsIn(await rows(factory, 'records')).length === 2, 'Both generations coexist while the new one is written');
  held.release();
  const published = await building;
  assert.equal(published.revision, 11); assert.equal(published.pending, null);
  const expectNext = one.engine.build({ items: next.laterOnItems, projects: next.laterOnProjects, bookmarks: next.laterOnBookmarkSearchState, bookmarkConfig: config });
  for (const query of ['', 'omega', 'rarely omega', 'alpha', 'book', 'zz']) {
    const result = await two.store.search(query, allowed);
    assert.deepEqual(plain({ results: result.results, total: result.total }), plain(one.engine.search(expectNext, query)), `New snapshot equivalent after publish: ${query}`);
    assert.equal(result.pending, undefined);
  }
  await one.store.idle();
  for (const name of ['records', 'postings', 'searchQueries']) assert.deepEqual(generationsIn(await rows(factory, name)), [published.generation], `Superseded ${name} rows are removed`);
  const sweeps = writes.filter(entry => entry.deletes);
  assert(sweeps.length && sweeps.every(entry => entry.stores.length === 1), 'Old generations are removed in single-store transactions');

  // Medium density: more candidates than twice the page; hydrate only the winners.
  recordGets = 0;
  const medium = await two.store.search('rarely', allowed, { limit: 20 });
  assert.equal(medium.total, 300);
  assert(recordGets <= 20, `Only the visible winners are hydrated (${recordGets} record reads)`);
  assert.deepEqual(plain({ results: medium.results, total: medium.total }), plain(one.engine.search(expectNext, 'rarely', { limit: 20 })));
  recordGets = 0;
  await two.store.search('omega 阅读 12', allowed, { limit: 20 });
  assert(recordGets <= 40, 'Sparse queries read at most twice the page of records');

  // A late writer with an older revision loses, within or across contexts.
  await assert.rejects(two.store.putSearchSource(old, 9), /staleLocalIndex/, 'An older source cannot replace a newer published snapshot');
  assert.equal((await one.store.search('alpha', allowed)).total, 0);
  const late = one.hold();
  const lateBuild = one.store.putSearchSource(old, 12);
  await late.reached;
  await two.store.putSearchSource(next, 13);
  late.release();
  await assert.rejects(lateBuild, /staleLocalIndex/, 'A build overtaken by a newer publish in another context cannot publish');
  assert.equal((await one.store.info('search')).revision, 13);
  assert.equal((await one.store.search('alpha', allowed)).total, 0);
  // An overtaken build stops within a few chunks instead of writing everything.
  const early = one.hold();
  const doomed = one.store.putSearchSource(sourceWith(3000, 'doomed'), 14);
  await early.reached;
  await two.store.putSearchSource(next, 15);
  const mark = writes.length;
  early.release();
  await assert.rejects(doomed, /staleLocalIndex/);
  const after = writes.slice(mark).filter(entry => entry.puts > 0 && entry.stores.length === 1 && ['records', 'postings', 'searchQueries'].includes(entry.stores[0]));
  assert(after.length <= 4, `A superseded writer notices the newer claim between chunks (${after.length} more chunks)`);
  // Taken over after its last chunk: the publish itself refuses.
  const small = sourceWith(300, 'tail');
  const lastChunk = one.hold(entry => entry.stores[0] === 'searchQueries');
  const tail = one.store.putSearchSource(small, 16);
  await lastChunk.reached;
  await two.store.putSearchSource(next, 17);
  lastChunk.release();
  await assert.rejects(tail, /staleLocalIndex/, 'Publishing re-checks the claim after the final chunk');
  assert.equal((await one.store.info('search')).revision, 17);
  assert.equal((await one.store.search('tail', allowed)).total, 0);
  // A live claim with a newer revision also stops an older build.
  const claimHolder = one.hold();
  const newerBuild = one.store.putSearchSource(next, 20);
  await claimHolder.reached;
  await assert.rejects(two.store.putSearchSource(old, 19), /staleLocalIndex/, 'A live newer claim refuses an older build');
  claimHolder.release(); await newerBuild;
  // Explicit invalidation accepts any revision, then serves it.
  await two.store.markDirty('search');
  assert.equal(await one.store.search('', allowed), null);
  await two.store.putSearchSource(old, 5);
  assert.equal((await one.store.info('search')).revision, 5);
  assert.equal((await one.store.search('alpha', allowed)).total > 0, true);
  // An equal revision taking over a claim makes the first writer stop.
  const taken = one.hold();
  const overtaken = one.store.putSearchSource(next, 30);
  await taken.reached;
  await two.store.putSearchSource(next, 30);
  taken.release();
  await assert.rejects(overtaken, /staleLocalIndex/);
  await one.store.idle(); await two.store.idle();
  assert.deepEqual(generationsIn(await rows(factory, 'records')), [(await one.store.info('search')).generation], 'Abandoned generations are swept');

  // A failing chunk keeps the published snapshot and releases its claim.
  const before = await one.store.search('omega', allowed);
  failStore = 'searchQueries';
  await assert.rejects(one.store.putSearchSource(sourceWith(600, 'broken'), 40), /injected/);
  failStore = null;
  const afterFailure = await one.store.info('search');
  assert.equal(afterFailure.pending, null); assert.equal(afterFailure.revision, 30);
  assert.deepEqual(plain(await one.store.search('omega', allowed)), plain(before));
  assert.equal((await one.store.search('broken', allowed)).total, 0, 'Rows written before the failure are never visible');
  await one.store.putSearchSource(sourceWith(600, 'retried'), 41);
  assert.equal((await one.store.search('retried', allowed)).total, 1000, 'A build succeeds after a failed one (600 Reading + 400 bookmark pages)');
  await one.store.idle();
  assert.deepEqual(generationsIn(await rows(factory, 'records')), [(await one.store.info('search')).generation], 'The failed generation is swept');

  // Bookmarks: same publication, cross-context ordering and patch semantics.
  const shared = new IDBFactory(), a = host(shared), b = host(shared);
  await a.store.putBookmarkState(bookmarks(1200, 100, 'first'));
  const bookmarkHold = a.hold();
  const rebuilding = a.store.putBookmarkState(bookmarks(1500, 200, 'second'));
  await bookmarkHold.reached;
  const meanwhile = await b.store.bookmarkView({ query: 'first page' }, allowed);
  assert.equal(meanwhile.view.totalPages, 1200, 'Bookmark readers keep the published snapshot during a rebuild');
  assert.deepEqual(plain((await b.store.membership(['https://n.test/1199?q=1199#h', 'https://n.test/1400?q=1400#h'], allowed)).matches), ['https://n.test/1199?q=1199#h']);
  assert.equal((await b.store.putBookmarkState(bookmarks(10, 150, 'older'))).stale, true, 'A live newer claim makes an older state stale');
  const patchDuring = await b.store.patchBookmarkPreviews({ records: [{ id: 'n3', url: 'https://n.test/3?q=3#h', description: '补丁' }] }, { updatedAt: 101, baseUpdatedAt: 100, scopeId: null });
  assert.equal(patchDuring.applied, true, 'A preview patch applies to the published generation while a rebuild is pending');
  bookmarkHold.release();
  const second = await rebuilding;
  assert.equal(second.applied, true); assert.equal(second.updatedAt, 200);
  assert.equal((await b.store.bookmarkView({}, allowed)).view.totalPages, 1500);
  assert.equal((await b.store.bookmarkView({ query: '补丁' }, allowed)).view.totalPages, 0, 'The new generation is built from its own state, not old patch rows');
  assert.equal((await a.store.putBookmarkState(bookmarks(10, 150, 'older'))).stale, true, 'An older state cannot replace a newer published one');
  const bookmarkWrites = writes.filter(entry => entry.stores.some(name => ['bookmarkNodes', 'bookmarkTerms', 'bookmarkQueries'].includes(name)) && !entry.stores.includes('bookmarkMeta'));
  assert(bookmarkWrites.every(entry => entry.stores.length === 1 && entry.puts <= 500), 'Bookmark builds use short single-store transactions');
  await a.store.idle(); await b.store.idle();
  for (const name of ['bookmarkNodes', 'bookmarkTerms', 'bookmarkQueries', 'bookmarkTermExtras']) {
    const left = generationsIn(await rows(shared, name));
    assert(left.every(gen => gen === second.generation), `Only the published bookmark generation remains in ${name}`);
  }
  console.log('PASS local index generations: short bounded write transactions, published snapshot served during held rebuilds, pending marker, cross-context latest-wins, invalidation, failure release, sweeping and bounded Quick hydration (simulated IndexedDB)');
})().catch(error => { console.error(error); process.exitCode = 1; });

// Quick Switcher reads the bookmark search source from the published local
// index in bounded blocks instead of the large Chrome storage mirror.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fakeIndexedDB = require('fake-indexeddb');
const { IDBFactory, IDBKeyRange } = fakeIndexedDB;
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const image = 'data:image/png;base64,' + 'A'.repeat(4096);

// Record every getAll so the test can bound block reads and prove that no
// cover payload is ever cloned out of the database.
const reads = [];
for (const proto of [fakeIndexedDB.IDBObjectStore.prototype, fakeIndexedDB.IDBIndex.prototype]) {
  const getAll = proto.getAll;
  proto.getAll = function (...args) {
    const req = getAll.apply(this, args);
    const store = this.objectStore ? this.objectStore.name : this.name;
    reads.push({ store, index: this.objectStore ? this.name : null, count: args[1], req });
    return req;
  };
}
function host(factory, { slow = 0 } = {}) {
  const context = vm.createContext({ indexedDB: factory, IDBKeyRange, URL, setTimeout, clearTimeout, console });
  vm.runInContext(read('url-utils.js'), context);
  vm.runInContext(read('quick-switcher-search.js'), context);
  if (slow) context.LaterOnQuickSearch.yieldTask = () => new Promise(resolve => setTimeout(resolve, slow));
  vm.runInContext(read('local-index.js'), context);
  return context;
}
function bookmarks(count, updatedAt, { scopeId = null, label = 'Page' } = {}) {
  const folders = [
    { id: '1', parentId: '0', title: '书签栏', path: '书签栏', protected: true, writable: false, folderType: 'bookmarks-bar' },
    { id: 'scope', parentId: '1', title: 'Research', path: '书签栏 / Research', protected: false, writable: true, dateAdded: 5 },
    { id: 'deep', parentId: 'scope', title: '文献方法', path: '书签栏 / Research / 文献方法', protected: false, writable: true },
    { id: 'other', parentId: '0', title: 'Other', path: 'Other', protected: true, writable: false, folderType: 'other' }];
  const parents = ['1', 'scope', 'deep', 'other'];
  const pages = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, parentId: parents[i % 4], title: `${label} ${i} 研究`,
    url: `https://site${i % 17}.test/a/${i}?q=${i}&x=%E4%B8%AD#frag${i}`, path: `${label} path ${i}`, dateAdded: 1000 + i,
    protected: false, writable: false, ...(i % 5 === 0 ? { preview: { url: `https://site${i % 17}.test/a/${i}`, image, description: 'summary text' } } : {}) }));
  const inScope = id => !scopeId || ['scope', 'deep'].includes(id);
  return { enabled: true, scopeId, error: null, updatedAt, folders,
    nodes: [...folders.filter(node => inScope(node.id)), ...pages.filter(node => inScope(node.parentId))] };
}
const lean = node => { const { preview, ...rest } = node; return rest; };
const byId = list => new Map(list.map(node => [node.id, node]));
function assertEquivalent(source, state, message) {
  assert.equal(source.enabled, state.enabled); assert.equal(source.scopeId, state.scopeId); assert.equal(source.error, state.error);
  const expectedFolders = byId(state.folders.map(lean)), actualFolders = byId(source.folders);
  assert.equal(actualFolders.size, expectedFolders.size, `${message}: every folder is listed`);
  for (const [id, node] of expectedFolders) assert.deepEqual(plain(actualFolders.get(id)), plain(node), `${message}: folder ${id} keeps its lean fields`);
  const expectedPages = state.nodes.filter(node => node.url).map(lean), actualPages = source.nodes.filter(node => node.url);
  assert.deepEqual(plain(actualPages), plain(expectedPages), `${message}: pages keep native ids, original URLs, titles, paths and order`);
  assert.deepEqual(plain(source.nodes.filter(node => !node.url).map(node => node.id).sort()), plain(state.nodes.filter(node => !node.url).map(node => node.id).sort()),
    `${message}: scoped folders are included in nodes`);
  assert(!JSON.stringify(source).includes('data:image'), `${message}: no cover payload in the source`);
}
(async () => {
  const factory = new IDBFactory();
  const a = host(factory), store = a.LaterOnLocalIndex;
  assert.equal(await store.bookmarkSearchSource(), null, 'No index yields null');

  const first = bookmarks(1100, 100, { scopeId: 'scope' });
  assert.equal((await store.putBookmarkState(first)).applied, true);
  const info = await store.info('bookmarks');
  assert.equal(info.searchSourceReady, true, 'Published metadata advertises the source');
  reads.length = 0;
  const source = await store.bookmarkSearchSource({ updatedAt: 100 });
  assertEquivalent(source, first, 'Scoped source');
  assert.equal(source.updatedAt, 100);
  const blockReads = reads.filter(entry => entry.store === 'bookmarkTermExtras');
  assert(blockReads.length >= 2, 'Pages are read in several blocks');
  assert(blockReads.every(entry => entry.count === 1 && (entry.req.result || []).length <= 1 && (entry.req.result?.[0]?.rows.length || 0) <= 256),
    'Each read returns at most one block of at most 256 rows');
  assert.equal(reads.filter(entry => entry.store === 'bookmarkNodes' && entry.index !== 'kind').length, 0, 'Page nodes are never read');
  assert(reads.every(entry => !JSON.stringify(entry.req.result || null).includes('data:image')), 'No read clones a cover image');
  assert.equal(reads.filter(entry => entry.store === 'bookmarkQueries').length, 0, 'Dense query blocks are not used for the source');
  const queryBlock = (await new Promise(resolve => { const r = factory.open('lateron-local-index-v1'); r.onsuccess = () => resolve(r.result); }))
    .transaction('bookmarkQueries').objectStore('bookmarkQueries');
  const sample = await new Promise(resolve => { const r = queryBlock.getAll(undefined, 1); r.onsuccess = () => resolve(r.result[0]); });
  assert.deepEqual(Object.keys(sample.rows[0]).sort(), ['id', 'parentId', 'position', 'searchText'], 'Query blocks keep only their search columns');

  // The source supports the same search entries as the original mirror.
  const engine = a.LaterOnQuickSearch, config = { enabled: true, scopeId: 'scope' };
  const fromSource = engine.build({ bookmarks: source, bookmarkConfig: config });
  const fromMirror = engine.build({ bookmarks: first, bookmarkConfig: config });
  assert.deepEqual(plain(fromSource).map(({ id, title, folderNames, bookmarkIds }) => ({ id, title, folderNames, bookmarkIds })),
    plain(fromMirror).map(({ id, title, folderNames, bookmarkIds }) => ({ id, title, folderNames, bookmarkIds })), 'Search entries match the mirror');

  const whole = bookmarks(300, 120);
  await store.putBookmarkState(whole);
  assertEquivalent(await store.bookmarkSearchSource(), whole, 'Unscoped source');
  assert.equal(await store.bookmarkSearchSource({ updatedAt: 121 }), null, 'An older index than requested yields null');

  // A snapshot written before this field existed has no source blocks.
  const db = await new Promise(resolve => { const r = factory.open('lateron-local-index-v1'); r.onsuccess = () => resolve(r.result); });
  await new Promise(resolve => {
    const tx = db.transaction('bookmarkMeta', 'readwrite'), metaStore = tx.objectStore('bookmarkMeta');
    const r = metaStore.get('bookmarks');
    r.onsuccess = () => { const { searchSourceReady, ...old } = r.result; metaStore.put(old); };
    tx.oncomplete = resolve;
  });
  assert.equal(await store.bookmarkSearchSource(), null, 'An older generation without source fields yields null');
  await store.putBookmarkState({ ...whole, updatedAt: 130 });

  // Cancellation stops reading at once.
  let calls = 0; reads.length = 0;
  assert.equal(await store.bookmarkSearchSource({ isCurrent: () => ++calls < 3 }), null, 'Cancelled reads return null');
  assert(reads.filter(entry => entry.store === 'bookmarkTermExtras').length <= 2, 'Cancellation stops further block reads');

  // A newer generation published by another context during the read cannot
  // produce a mixed snapshot.
  const slow = host(factory, { slow: 25 }), writer = host(factory);
  const big = bookmarks(2000, 140, { label: 'Before' });
  await writer.LaterOnLocalIndex.putBookmarkState(big);
  let blocksSeen = 0;
  const reading = slow.LaterOnLocalIndex.bookmarkSearchSource({ isCurrent: () => { blocksSeen++; return true; } });
  while (blocksSeen < 2) await new Promise(resolve => setTimeout(resolve, 5));
  const after = bookmarks(2000, 150, { label: 'After' });
  assert.equal((await writer.LaterOnLocalIndex.putBookmarkState(after)).applied, true);
  await writer.LaterOnLocalIndex.idle();
  assert.equal(await reading, null, 'A read overlapping a new publication returns null instead of mixing generations');
  const fresh = await slow.LaterOnLocalIndex.bookmarkSearchSource({ updatedAt: 150 });
  assertEquivalent(fresh, after, 'Re-read after publication');
  assert(fresh.nodes.filter(node => node.url).every(node => node.title.startsWith('After')));

  // Preview patches change covers only; the source remains the same snapshot.
  const patchedAt = 160;
  const patched = await writer.LaterOnLocalIndex.patchBookmarkPreviews({ records: [{ id: 'p1', url: after.nodes.find(node => node.id === 'p1').url, image, description: 'New cover' }] },
    { updatedAt: patchedAt, baseUpdatedAt: 150, scopeId: null });
  assert(patched && patched.applied !== false && patched.updatedAt === patchedAt, 'The preview patch applies to the published snapshot');
  const afterPatch = await slow.LaterOnLocalIndex.bookmarkSearchSource({ updatedAt: patchedAt });
  assert(afterPatch, 'The source is available at the patched revision');
  assertEquivalent(afterPatch, after, 'Source after a preview patch');

  // Bookmark views answer null from metadata alone when the snapshot cannot
  // serve the caller, without queuing behind a build that holds the data stores.
  const allowed = { bookmarkPermission: true, bookmarkConfig: { enabled: true, scopeId: null } };
  const viewDb = new IDBFactory(), viewer = host(viewDb).LaterOnLocalIndex;
  const holdData = async () => {
    const db = await new Promise(resolve => { const r = viewDb.open('lateron-local-index-v1'); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(['bookmarkNodes'], 'readwrite');
    let released = false, release;
    const keep = () => { if (!released) tx.objectStore('bookmarkNodes').get(['hold', 'hold']).onsuccess = keep; };
    keep();
    return () => { released = true; return new Promise(resolve => { tx.oncomplete = resolve; }); };
  };
  const bounded = async (promise, message) => {
    let timer;
    const result = await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${message} (blocked)`)), 500); })]);
    clearTimeout(timer); return result;
  };
  await viewer.info('bookmarks');
  let release = await holdData();
  assert.equal(await bounded(viewer.bookmarkView({}, allowed), 'Unbuilt index'), null, 'No published snapshot: null without waiting for data stores');
  await release();
  await viewer.putBookmarkState({ ...whole, updatedAt: 170 });
  release = await holdData();
  assert.equal(await bounded(viewer.bookmarkView({}, { ...allowed, bookmarkConfig: { enabled: true, scopeId: 'scope' } }), 'Scope mismatch'), null,
    'A snapshot for another scope answers null from metadata alone');
  assert.equal(await bounded(viewer.bookmarkView({}, { ...allowed, bookmarkPermission: false }), 'Permission'), null);
  const pendingView = viewer.bookmarkView({}, allowed);
  await release();
  const served = await pendingView;
  assert.equal(served.updatedAt, 170, 'A usable snapshot is still served once the data stores are free');
  assert.equal(served.view.totalPages, 300);

  // A publication between the metadata check and the data transaction is
  // caught by the second check: rows never mix generations.
  const viewerHost = host(viewDb), racing = viewerHost.LaterOnLocalIndex;
  const changed = bookmarks(300, 180, { label: 'Changed' });
  release = await holdData();
  const crossing = racing.bookmarkView({}, allowed);
  await new Promise(resolve => setTimeout(resolve, 20));
  const publishing = host(viewDb).LaterOnLocalIndex.putBookmarkState(changed);
  await release();
  const [view, published] = await Promise.all([crossing, publishing]);
  assert.equal(published.applied, true);
  const titles = view.nodes.filter(node => node.url).map(node => node.title);
  assert(titles.length && (titles.every(title => title.startsWith('Page')) || titles.every(title => title.startsWith('Changed'))), 'A view never mixes two generations');
  assert.equal(view.updatedAt === 180, titles[0].startsWith('Changed'), 'View rows match the generation its metadata reports');

  // Quick Switcher answers state which variant they came from.
  const quickDb = new IDBFactory(), quick = host(quickDb).LaterOnLocalIndex;
  const readingItems = [{ id: 'r1', title: 'Reading 研究', url: 'https://reading.test/a?q=1#x', savedAt: 10 }];
  await quick.putSearchSource({ laterOnItems: readingItems, laterOnProjects: [], laterOnBookmarkConfig: { enabled: true, scopeId: null },
    laterOnBookmarkSearchState: { enabled: true, scopeId: null, nodes: [{ id: 'b1', title: 'Bookmark 研究', url: 'https://book.test/', dateAdded: 5 }] } }, 1);
  const combined = await quick.search('研究', allowed);
  assert.equal(combined.bookmarkVariant, true, 'Allowed bookmarks: the combined rows were queried');
  assert.equal(combined.total, 2);
  for (const context of [{ ...allowed, bookmarkPermission: false }, { bookmarkPermission: true, bookmarkConfig: { enabled: true, scopeId: 'scope' } }, { bookmarkPermission: true }]) {
    const only = await quick.search('研究', context);
    assert.equal(only.bookmarkVariant, false, 'Without matching permission/scope only Reading rows were queried');
    assert.equal(only.total, 1);
  }
  assert.equal((await quick.search('', { ...allowed, bookmarkPermission: false })).bookmarkVariant, false, 'Empty queries report the variant too');
  await quick.putSearchSource({ laterOnItems: readingItems, laterOnProjects: [], laterOnBookmarkConfig: { enabled: true, scopeId: null } }, 2);
  assert.equal((await quick.search('研究', allowed)).bookmarkVariant, false, 'A snapshot built without bookmark data is Reading-only even when bookmarks are allowed');
  console.log('PASS local index bookmark source: lean equivalence (scoped/unscoped), search-entry parity, <=1 block of <=256 rows per read, no cover or page-node reads, null for missing/old/outdated/cancelled, no mixed generations, strict preview patch, metadata-first bookmark views and Quick bookmarkVariant');
})().catch(error => { console.error(error); process.exitCode = 1; });

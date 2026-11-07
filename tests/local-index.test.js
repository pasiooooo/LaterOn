const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange, IDBObjectStore } = require('fake-indexeddb');
const indexedDB = new IDBFactory();
const plain = value => JSON.parse(JSON.stringify(value));
const root = path.resolve(__dirname, '..');
function host(factory = indexedDB) {
  const context = vm.createContext({ indexedDB: factory, IDBKeyRange, URL, setTimeout, clearTimeout });
  for (const file of ['url-utils.js', 'quick-switcher-search.js', 'local-index.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return { store: context.LaterOnLocalIndex, engine: context.LaterOnQuickSearch };
}
const config = { enabled: true, scopeId: null };
const permitted = { bookmarkConfig: config, bookmarkPermission: true };
const source = {
  laterOnItems: [
    { id: 'r1', url: 'https://example.test/paper?q=x#one', title: 'Obsidian Résumé', savedAt: 100, projectId: 'research' },
    { id: 'r2', url: 'https://example.test/paper?q=x#two', title: '科研入口', savedAt: 200 },
    { id: 'r3', url: 'https://google.com/search?q=%E9%87%8F%E5%AD%90', title: 'Search Results', savedAt: 300 },
    ...Array.from({ length: 600 }, (_, i) => ({ id: `item-${i}`, title: `Machine Learning 科研资料 ${i}`,
      url: `https://articles.test/read/${i}?source=saved#section-${i % 5}`, savedAt: 1000 + i, projectId: i % 2 ? 'research' : null }))
  ],
  laterOnProjects: [{ id: 'research', name: '博士研究', archived: true }],
  laterOnBookmarkConfig: config,
  laterOnBookmarkSearchState: { enabled: true, scopeId: null,
    folders: [{ id: '1', parentId: '0', title: '书签栏' }, { id: 'scope', parentId: '1', title: '文献方法' }],
    nodes: [
      { id: '1', parentId: '0', title: '书签栏' }, { id: 'scope', parentId: '1', title: '文献方法' },
      { id: 'b1', parentId: 'scope', title: '长期研究入口', url: 'https://example.test/paper?q=x#one', dateAdded: 400 },
      { id: 'b2', parentId: 'scope', title: 'Obsidian notes', url: 'https://book.test/', dateAdded: 500 },
      ...Array.from({ length: 700 }, (_, i) => ({ id: `book-${i}`, parentId: 'scope', title: `科研资料 Bookmark ${i}`,
        url: `https://bookmarks.test/read/${i}?query=研究#anchor`, dateAdded: 2000 + i }))
    ] }
};

(async () => {
  const first = host();
  const original = JSON.stringify(source);
  await first.store.putSearchSource(source, 7);
  assert.equal(JSON.stringify(source), original, 'Preparing a disposable index never mutates source records');
  const meta = await first.store.info();
  assert.equal(meta.ready, true);
  assert.equal(meta.revision, 7);
  assert.equal(meta.thinBookmarks, true);
  const expected = first.engine.build({ items: source.laterOnItems, projects: source.laterOnProjects,
    bookmarks: source.laterOnBookmarkSearchState, bookmarkConfig: config });
  for (const query of ['', '科研', '博士 方法', 'obsdn', 'CAFE rsm', 'resume', 'quantum', '量子',
    'book', 'b', 'aa', 'article/432', 'read/432', 'query=研究#anchor', '等待整理', 'Machine Learning', 'no-such-page']) {
    const actual = await first.store.search(query, permitted);
    assert.deepEqual(plain({ results: actual.results, total: actual.total }), plain(first.engine.search(expected, query)), `Persistent matching/ranking: ${query}`);
  }
  const originalGetAll = IDBObjectStore.prototype.getAll, originalGet = IDBObjectStore.prototype.get;
  let unboundedRecords = false, fullRecordReads = 0;
  IDBObjectStore.prototype.getAll = function(query, count) {
    if (this.name === 'records' && (count === undefined || count > 50)) unboundedRecords = true;
    return originalGetAll.call(this, query, count);
  };
  IDBObjectStore.prototype.get = function(key) {
    if (this.name === 'records') fullRecordReads++;
    return originalGet.call(this, key);
  };
  try {
    const broad = await first.store.search('e', permitted);
    assert(broad.total > 50, 'The broad-query fixture has more matches than the visible result slice');
    assert.deepEqual(plain({ results: broad.results, total: broad.total }), plain(first.engine.search(expected, 'e')));
    assert.equal(unboundedRecords, false, 'A broad query must not read every complete search record');
    assert(fullRecordReads <= 50, 'Only the visible winners need complete records');
  } finally {
    IDBObjectStore.prototype.getAll = originalGetAll;
    IDBObjectStore.prototype.get = originalGet;
  }
  assert.equal((await first.store.search('', permitted, { limit: 0 })).results.length, 0);
  assert.equal((await first.store.search('', permitted, { limit: 10000 })).results.length, 100);
  const id = expected.find(entry => entry.bookmarkIds.includes('b2')).id;
  assert.equal((await first.store.getEntry(id, permitted)).url, 'https://book.test/');
  const revoked = { ...permitted, bookmarkPermission: false };
  const readingOnly = first.engine.build({ items: source.laterOnItems, projects: source.laterOnProjects });
  assert.deepEqual(plain((await first.store.search('科研', revoked)).results), plain(first.engine.search(readingOnly, '科研').results), 'Revocation uses Reading titles and contexts, including on merged URLs');
  assert.equal(await first.store.getEntry(id, revoked), null);
  assert.equal(await first.store.getEntry(id, { ...permitted, bookmarkConfig: { enabled: true, scopeId: 'changed' } }), null, 'A different scope cannot serve the old combined index');

  const restarted = host();
  assert.equal((await restarted.store.search('', permitted)).total, expected.length, 'A new worker context reads the persisted recent slice without source data or an index build');
  await restarted.store.markDirty();
  assert.equal(await first.store.search('', permitted), null, 'Dirty snapshots cannot be served by another open context');
  await restarted.store.putSearchSource(source, 8);
  await assert.rejects(restarted.store.putSearchSource({ ...source, laterOnItems: [] }, 9, () => false), /staleLocalIndex/);
  assert.equal((await first.store.info()).revision, 8, 'Cancelled preparation leaves the last atomic snapshot intact');

  const bookmarkState = { enabled: true, scopeId: 'scope', updatedAt: 123,
    folders: [{ id: '1', parentId: '0', title: 'Outside' }, { id: 'scope', parentId: '1', title: 'Scope', writable: true },
      { id: 'nested', parentId: 'scope', title: 'Nested', writable: true }],
    nodes: [
      { id: 'scope', parentId: '1', title: 'Scope', writable: true }, { id: 'nested', parentId: 'scope', title: 'Nested', writable: true },
      { id: 'direct', parentId: 'scope', title: '机器学习 direct', url: 'https://inside.test/direct?q=1#one', dateAdded: 100, preview: { description: '正文摘要' } },
      { id: 'deep', parentId: 'nested', title: '机器学习 nested', url: 'https://inside.test/deep', dateAdded: 200, preview: { image: 'data:image/png;base64,QUJD', description: '深层内容' } },
      { id: 'outside', parentId: '1', title: '机器学习 outside', url: 'https://outside.test/', dateAdded: 300 }
    ] };
  await first.store.putBookmarkState(bookmarkState);
  const scoped = { bookmarkPermission: true, bookmarkConfig: { enabled: true, scopeId: 'scope' } };
  const all = await first.store.bookmarkView({ limit: 1 }, scoped);
  assert.equal(all.partial, true);
  assert.equal(all.view.totalPages, 2);
  assert.equal(all.nodes.filter(node => node.url).length, 1);
  assert.equal(all.nodes.find(node => node.url).id, 'deep', 'Recent native order is dateAdded descending');
  assert(all.nodes.filter(node => !node.url).every(node => ['scope', 'nested'].includes(node.id)), 'Out-of-scope folders do not become view roots');
  const direct = await first.store.bookmarkView({ selected: 'scope' }, scoped);
  assert.equal(direct.view.totalPages, 1, 'Unfiltered folder views show direct pages');
  assert.equal(direct.nodes.find(node => node.url).id, 'direct');
  assert.equal(direct.folders.find(node => node.id === 'nested').summary.previews[0].id, 'deep', 'Folder mosaics can hydrate a preview without displaying it as another list page');
  const recursive = await first.store.bookmarkView({ selected: 'scope', query: '机器学习', limit: 1 }, scoped);
  assert.equal(recursive.view.totalPages, 2, 'Filtered folder views search descendants');
  assert.equal(recursive.nodes.find(node => node.url).id, 'direct', 'Filtered results keep native tree order');
  assert.equal((await first.store.bookmarkView({ query: 'Outside' }, scoped)).view.totalPages, 0, 'Ancestor names outside the scope are not added to Bookmarks search text');
  assert.equal((await first.store.bookmarkView({ query: '正文摘要' }, scoped)).view.totalPages, 1);
  assert.equal(await first.store.bookmarkView({}, revoked), null);
  assert.equal(await first.store.bookmarkView({}, { ...scoped, bookmarkConfig: config }), null);
  assert.deepEqual(plain((await first.store.membership(['https://inside.test/direct?q=1#one', 'https://inside.test/direct?q=1#two', 'https://outside.test/'], scoped)).matches), ['https://inside.test/direct?q=1#one'], 'Bounded membership preserves query/fragment identity and scope');
  assert.deepEqual(plain((await first.store.membership(['https://inside.test/deep'], revoked)).matches), []);
  await first.store.markDirty('bookmarks');
  assert.equal(await first.store.bookmarkView({}, scoped), null);
  assert.deepEqual(plain((await first.store.membership(['https://inside.test/deep'], scoped)).matches), []);

  for (const version of [1, 3]) {
    const migrating = new IDBFactory();
    const legacy = await new Promise((resolve, reject) => {
      const opening = migrating.open('lateron-local-index-v1', version);
      opening.onupgradeneeded = () => {
        const info = opening.result.createObjectStore('info', { keyPath: 'key' });
        info.put({ key: 'search', ready: true, schema: version, revision: 99 });
        opening.result.createObjectStore('oldDisposableRows', { keyPath: 'id' }).put({ id: 'old' });
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    legacy.close();
    const upgraded = host(migrating);
    assert.equal(await upgraded.store.search('', permitted), null, 'A schema upgrade cannot reuse readiness from incompatible disposable rows');
    await upgraded.store.putBookmarkState(bookmarkState);
    assert.equal((await upgraded.store.bookmarkView({ query: '正文摘要' }, scoped)).view.totalPages, 1, 'Upgraded lightweight text blocks retain descriptions and folder/scope matching');
  }
  console.log('PASS local IndexedDB index: persistent restart, ranking, permissions/scope, cancellation, bounded hydration, URL membership and disposable schema upgrade (simulated IndexedDB)');
})().catch(error => { console.error(error); process.exitCode = 1; });

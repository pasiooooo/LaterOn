// Mode searches over the persistent index. Each selected set of libraries must
// match, rank, count and display exactly as an index built from those
// libraries alone: Bookmarks-only never uses Reading titles, projects or inbox
// state, Reading-only never uses bookmark titles or folders, and the combined
// mode keeps the edited Reading title. Live tab URLs are looked up in the same
// snapshot. Fake IndexedDB proves behavior and read counts, not Chrome timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange, IDBObjectStore, IDBIndex } = require('fake-indexeddb');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));

function host(factory) {
  const context = vm.createContext({ indexedDB: factory, IDBKeyRange, URL, setTimeout, clearTimeout });
  for (const file of ['url-utils.js', 'quick-switcher-search.js', 'local-index.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return { store: context.LaterOnLocalIndex, engine: context.LaterOnQuickSearch };
}
async function editMeta(factory, key, edit) {
  const db = await new Promise((resolve, reject) => { const r = factory.open('lateron-local-index-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('searchMeta', 'readwrite'), store = tx.objectStore('searchMeta'), read = store.get(key);
    read.onsuccess = () => { const next = edit(read.result); if (next === null) store.delete(key); else store.put(next); };
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}

const config = { enabled: true, scopeId: null };
const allowed = sources => ({ bookmarkConfig: config, bookmarkPermission: true, ...(sources ? { sources } : {}) });
const SHARED = 'https://shared.test/paper?q=1#part';
let seed = 0x5eed;
const random = limit => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 2 ** 32 * limit); };
const words = ['kepler', 'orbit', 'prism', 'harbor', '机器学习', '科研资料', 'résumé', 'dataset', 'review'];
const pick = () => words[random(words.length)];
// Reading pages, bookmark-only pages and pages in both libraries. Every
// timestamp is distinct so that the expected order has no ties.
function fixture(sharedCount = 300) {
  const items = [{ id: 'r-shared', title: 'ReadingEditedZeta', titleEdited: true, url: SHARED, savedAt: 900000, projectId: 'p' }];
  const folders = [{ id: '1', parentId: '0', title: 'Bar' }, { id: 'f', parentId: '1', title: 'FolderKappa' }, { id: 'g', parentId: '1', title: '文献夹' }];
  const nodes = [...folders, { id: 'b-shared', parentId: 'f', title: 'NativeBookTitle', url: SHARED, dateAdded: 100 }];
  for (let i = 0; i < 700; i++) {
    const url = `https://read.test/${i}?v=${i}#s${i % 3}`;
    items.push({ id: `r${i}`, title: `Reading ${pick()} ${pick()} ${i}`, url, savedAt: 1000 + i * 7, projectId: i % 4 ? null : 'p' });
    if (i < sharedCount) nodes.push({ id: `bs${i}`, parentId: i % 2 ? 'f' : 'g', title: `Marked ${pick()} ${i}`, url, dateAdded: 200000 + i * 11 });
  }
  for (let i = 0; i < 900; i++) nodes.push({ id: `b${i}`, parentId: i % 3 ? 'g' : 'f', title: `Bookmark ${pick()} ${pick()} ${i}`,
    url: `https://book.test/${i}?q=${i}#a`, dateAdded: 500000 + i * 13 });
  return { laterOnItems: items, laterOnProjects: [{ id: 'p', name: 'ProjectOmega' }], laterOnBookmarkConfig: config,
    laterOnBookmarkSearchState: { enabled: true, scopeId: null, folders, nodes } };
}
// What a separate index of only these libraries would contain.
function expected(engine, source, sources) {
  const reading = sources.includes('reading'), books = sources.includes('bookmarks');
  return engine.build({ ...(reading ? { items: source.laterOnItems, projects: source.laterOnProjects } : {}),
    ...(books ? { bookmarks: source.laterOnBookmarkSearchState, bookmarkConfig: config } : {}) });
}
const view = result => plain({ results: result.results, total: result.total });
const matches = (engine, entry, query) => engine.searchRecords([{ entry, position: 0, values: engine.fields(entry) }], query, { limit: 1 }).results[0]?.score ?? null;
const COMBOS = [['tabs'], ['reading'], ['bookmarks'], ['tabs', 'reading'], ['tabs', 'bookmarks'], ['reading', 'bookmarks'], ['tabs', 'reading', 'bookmarks']];

(async () => {
  const factory = new IDBFactory(), { store, engine } = host(factory), source = fixture();
  await store.putSearchSource(source, 5);
  const meta = await store.info();
  assert.equal(meta.sourceViews, true);
  assert.equal(meta.sharedPages, 301, 'Every URL in both libraries gets a bookmark-only view');

  // Every library subset equals its own separate index, for fixed and random
  // queries, including dense and fuzzy ones; tabs are not a library source.
  const queries = ['', 'e', 'a', 'reading', 'marked', 'bookmark 899', 'kepler orbit', '机器', '科研资料', 'resume', 'krplr', 'prsm',
    'ReadingEditedZeta', 'NativeBookTitle', 'ProjectOmega', 'FolderKappa', '文献夹', '等待整理', 'inbox', 'shared.test', 'q=1#part', 'zzzq'];
  for (let i = 0; i < 40; i++) queries.push(`${pick()} ${random(900)}`, pick().slice(0, 1 + random(4)));
  const libraries = combo => combo.filter(name => name !== 'tabs');
  for (const combo of COMBOS) {
    const index = libraries(combo).length ? expected(engine, source, libraries(combo)) : [];
    for (const query of queries) for (const limit of [50, 7]) {
      const actual = await store.search(query, allowed(combo), { limit });
      assert.equal(actual.sourcesFiltered, true, `${combo}: a mode answer states its source filtering`);
      assert.equal(actual.generation, meta.generation);
      assert.deepEqual(view(actual), plain(index.length ? engine.search(index, query, { limit }) : { results: [], total: 0 }),
        `${combo.join('+')} equals a separate index: ${JSON.stringify(query)} limit ${limit}`);
    }
  }
  // The old library API is unchanged.
  const combined = expected(engine, source, ['reading', 'bookmarks']);
  for (const query of ['', 'e', 'NativeBookTitle']) {
    const old = await store.search(query, allowed());
    assert.deepEqual(view(old), plain(engine.search(combined, query)));
    assert.equal(old.sourcesFiltered, undefined, 'Calls without sources keep the original answer shape');
  }

  // Shared fields never cross libraries.
  const only = async (query, sources) => (await store.search(query, allowed(sources))).results;
  for (const query of ['ReadingEditedZeta', 'ProjectOmega', '等待整理 marked 1']) assert.equal((await only(query, ['bookmarks'])).filter(entry => entry.url === SHARED).length, 0, `Bookmarks-only ignores Reading text: ${query}`);
  for (const query of ['NativeBookTitle', 'FolderKappa']) assert.equal((await only(query, ['reading'])).filter(entry => entry.url === SHARED).length, 0, `Reading-only ignores bookmark text: ${query}`);
  const book = (await only('NativeBookTitle', ['bookmarks'])).find(entry => entry.url === SHARED);
  assert.equal(book.title, 'NativeBookTitle');
  assert.deepEqual(plain([book.readingIds, book.projectNames, book.bookmarkIds, book.folderNames]), [[], [], ['b-shared'], ['Bar / FolderKappa']], 'Bookmarks-only shows bookmark data only');
  assert(!JSON.stringify(book).includes('ReadingEditedZeta') && !JSON.stringify(book).includes('ProjectOmega'));
  const both = (await only('NativeBookTitle', ['reading', 'bookmarks'])).find(entry => entry.url === SHARED);
  assert.equal(both.title, 'ReadingEditedZeta', 'The combined mode keeps the edited Reading title');
  assert.deepEqual(plain([both.readingIds, both.bookmarkIds]), [['r-shared'], ['b-shared']]);

  // Opening uses the same selection.
  assert.equal((await store.getEntry(`page:${SHARED}`, allowed(['bookmarks']))).title, 'NativeBookTitle');
  assert.equal((await store.getEntry(`page:${SHARED}`, allowed(['reading']))).title, 'ReadingEditedZeta');
  assert.deepEqual(plain((await store.getEntry(`page:${SHARED}`, allowed(['reading']))).bookmarkIds), []);
  assert.equal(await store.getEntry('page:https://book.test/3?q=3#a', allowed(['reading'])), null, 'A bookmark-only page is not a Reading result');
  assert.equal(await store.getEntry('page:https://read.test/699?v=699#s0', allowed(['bookmarks'])), null, 'A Reading-only page is not a Bookmarks result');
  assert.equal(await store.getEntry(`page:${SHARED}`, allowed(['tabs'])), null);
  assert.equal(await store.getEntry(`page:${SHARED}`, { ...allowed(['bookmarks']), bookmarkPermission: false }), null, 'Revoked permission removes Bookmarks from a mode');
  const revoked = await store.search('NativeBookTitle', { ...allowed(['bookmarks']), bookmarkPermission: false });
  assert.deepEqual(view(revoked), { results: [], total: 0 });
  assert.equal(revoked.sourcesFiltered, true);
  assert.equal((await store.search('marked', { ...allowed(['reading', 'bookmarks']), bookmarkConfig: { enabled: true, scopeId: 'other' } })).bookmarkVariant, false, 'A different scope falls back to Reading rows');

  // Lookups: every requested URL with membership in the selected libraries,
  // whether or not it matches, scored by the same rules as the total.
  const lookupUrls = [SHARED, 'https://read.test/3?v=3#s0', 'https://book.test/4?q=4#a', 'https://book.test/4?q=4', 'https://absent.test/', 'chrome://settings/'];
  for (const combo of COMBOS) {
    const index = libraries(combo).length ? expected(engine, source, libraries(combo)) : [];
    const byUrl = new Map(index.map(entry => [entry.url, entry]));
    for (const query of ['', 'kepler', 'NativeBookTitle', 'ReadingEditedZeta', 'ProjectOmega', 'zzzq']) {
      const actual = await store.search(query, { ...allowed(combo), lookupUrls }, { limit: 5 });
      const wanted = lookupUrls.filter(url => byUrl.has(url));
      assert.deepEqual(plain((actual.lookupEntries || []).map(found => found.url)), wanted, `${combo}: lookups return exactly the members (${query})`);
      for (const found of actual.lookupEntries || []) {
        const truth = byUrl.get(found.url);
        assert.deepEqual(plain(found.entry), plain(truth), `${combo}: lookup entries are the selected-library projection`);
        assert.deepEqual(plain(found.values), plain(engine.fields(truth)), `${combo}: lookup values are the prepared fields`);
        assert.equal(found.libraryScore, query ? matches(engine, truth, query) : 0, `${combo}: lookup score agrees with the total (${query})`);
      }
    }
  }
  const outside = await store.search('marked', { ...allowed(['bookmarks']), lookupUrls: ['https://read.test/0?v=0#s0'] }, { limit: 5 });
  assert(outside.total > 5 && !outside.results.some(entry => entry.url === 'https://read.test/0?v=0#s0'), 'The looked-up page is outside the result slice');
  assert.equal(outside.lookupEntries.length, 1);
  assert.equal(typeof outside.lookupEntries[0].libraryScore, 'number', 'A matching lookup outside the slice is reported as counted');
  assert.equal(outside.lookupEntries[0].entry.title.startsWith('Marked'), true, 'A shared lookup in Bookmarks-only uses its bookmark title');

  // Bounded reads: no unbounded complete-record reads, visible winners only.
  const getAll = IDBObjectStore.prototype.getAll, get = IDBObjectStore.prototype.get;
  let unbounded = 0, recordGets = 0;
  IDBObjectStore.prototype.getAll = function (query, count) { if (this.name === 'records' && (count === undefined || count > 100)) unbounded++; return getAll.call(this, query, count); };
  IDBObjectStore.prototype.get = function (...args) { if (this.name === 'records') recordGets++; return get.apply(this, args); };
  try {
    for (const query of ['', 'e', 'marked', 'kepler']) {
      recordGets = 0;
      await store.search(query, allowed(['bookmarks']), { limit: 20 });
      assert(recordGets <= 40, `Bookmarks-only hydrates at most two pages of records (${query}: ${recordGets})`);
    }
    assert.equal(unbounded, 0);
  } finally { IDBObjectStore.prototype.getAll = getAll; IDBObjectStore.prototype.get = get; }

  // A new publication replaces rows and membership together.
  const changed = fixture(10);
  changed.laterOnBookmarkSearchState.nodes.find(node => node.id === 'b-shared').title = 'RenamedNative';
  await store.putSearchSource(changed, 6);
  const next = await store.info();
  assert.equal(next.sharedPages, 11);
  const renamed = await store.search('RenamedNative', { ...allowed(['bookmarks']), lookupUrls: [SHARED] });
  assert.equal(renamed.generation, next.generation);
  assert.equal(renamed.results[0]?.title, 'RenamedNative');
  assert.equal(renamed.lookupEntries[0].entry.title, 'RenamedNative', 'Lookups and results come from the same generation');
  assert.deepEqual(view(await store.search('marked', allowed(['bookmarks']))), plain(engine.search(expected(engine, changed, ['bookmarks']), 'marked')));
  // A cancelled build leaves the published rows and membership in place.
  await assert.rejects(store.putSearchSource(fixture(), 7, () => false), /staleLocalIndex/);
  assert.equal((await store.search('RenamedNative', allowed(['bookmarks']))).results[0]?.title, 'RenamedNative');
  assert.equal((await store.info()).generation, next.generation);

  // An older snapshot without source views: Bookmarks-only cannot be answered
  // (the worker rebuilds once), the other selections still can.
  await editMeta(factory, 'searchSources', () => null);
  assert.equal(await store.search('marked', allowed(['bookmarks'])), null);
  assert.equal(await store.getEntry(`page:${SHARED}`, allowed(['bookmarks'])), null);
  assert.deepEqual(view(await store.search('marked', allowed(['reading', 'bookmarks']))), plain(engine.search(expected(engine, changed, ['reading', 'bookmarks']), 'marked')));
  assert.deepEqual(view(await store.search('reading', allowed(['reading']))), plain(engine.search(expected(engine, changed, ['reading']), 'reading')));
  // The next publication restores them.
  await store.putSearchSource(changed, 8);
  assert.deepEqual(view(await store.search('marked', allowed(['bookmarks']))), plain(engine.search(expected(engine, changed, ['bookmarks']), 'marked')));
  // Membership of another generation is never used.
  await editMeta(factory, 'searchSources', record => ({ ...record, generation: record.generation - 1 }));
  assert.equal(await store.search('marked', allowed(['bookmarks'])), null, 'Membership from another generation is rejected');

  // Native imports can give many bookmarks the same timestamp. Their order
  // must equal a separate Bookmarks index, even when Reading times reverse
  // the shared rows' combined positions. Include Book-only pages as well.
  const tied = { laterOnItems: [], laterOnProjects: [], laterOnBookmarkConfig: config,
    laterOnBookmarkSearchState: { enabled: true, scopeId: null, nodes: [] } };
  for (let i = 0; i < 1105; i++) {
    const url = `https://tie.test/${String(i).padStart(4, '0')}?q=kept#exact`;
    tied.laterOnItems.push({ id: `rt${i}`, url, title: 'Reading reverse order', savedAt: 10000 + i });
    tied.laterOnBookmarkSearchState.nodes.push({ id: `bt${i}`, url, title: 'Marked EqualDate', dateAdded: 100 });
  }
  for (let i = 0; i < 40; i++) tied.laterOnBookmarkSearchState.nodes.push({ id: `bonly${i}`,
    url: `https://tie.test/${String(i).padStart(4, '0')}-only?q=kept#exact`, title: 'Marked EqualDate', dateAdded: 100 });
  const tiedFactory = new IDBFactory(), tiedHost = host(tiedFactory);
  await tiedHost.store.putSearchSource(tied, 1);
  const tiedTruth = expected(tiedHost.engine, tied, ['bookmarks']);
  for (const query of ['', 'marked', 'equaldate', 'tie.test', '0000', '1104']) for (const limit of [3, 50, 100]) {
    assert.deepEqual(view(await tiedHost.store.search(query, allowed(['bookmarks']), { limit })),
      plain(tiedHost.engine.search(tiedTruth, query, { limit })), `Tied Book dates never use Reading order: ${query} / ${limit}`);
  }
  const manyUrls = tied.laterOnItems.map(item => item.url);
  const many = await tiedHost.store.search('native-project-cross-token', { ...allowed(['reading']), lookupUrls: manyUrls }, { limit: 3 });
  assert.equal(many.lookupEntries.length, manyUrls.length, 'All 1105 requested live URLs receive same-snapshot membership lookups');
  assert.equal(many.lookupEntries.at(-1).entry.url, manyUrls.at(-1));
  assert(many.lookupEntries.every(found => found.libraryScore === null), 'Independent nonmatches are included for cross-source matching');

  const indexGet = IDBIndex.prototype.get;
  let isCurrent = true, checks = 0, lookups = 0, succeeded = 0;
  IDBIndex.prototype.get = function (...args) {
    const pending = indexGet.apply(this, args); lookups++;
    pending.addEventListener('success', () => { succeeded++; if (succeeded === 1) isCurrent = false; });
    return pending;
  };
  try {
    const cancelled = await tiedHost.store.search('marked', { ...allowed(['bookmarks']), lookupUrls: manyUrls,
      isCurrent: () => { checks++; return isCurrent; } }, { limit: 3 });
    assert.equal(cancelled, null, 'A cancelled query never returns partial lookups as complete');
    assert(checks > 0 && lookups <= 256, 'Cancellation stops between bounded batches of live URL reads');
    assert.equal(succeeded, lookups, 'Every request already issued has settled before returning cancellation');
  } finally { IDBIndex.prototype.get = indexGet; }
  assert.equal((await tiedHost.store.search('marked', allowed(['bookmarks']), { limit: 3 })).total, tiedTruth.length,
    'Cancellation leaves the readable index intact');
  console.log('PASS local index sources: all seven mode selections equal separate indexes (matching, ranking, totals and fields), Bookmarks-only never uses Reading text and the reverse, combined keeps edited Reading titles, same-snapshot lookups with consistent scores, filtered opening, bounded reads, atomic republication and cancellation, and older snapshots (simulated IndexedDB)');
})().catch(error => { console.error(error); process.exitCode = 1; });

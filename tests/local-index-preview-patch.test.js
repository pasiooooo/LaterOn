// Preview batches must not take down the bounded bookmark view, and writes from
// any context must never let an older state replace a newer one. The oracle for
// each patch is a full build of the equivalent state in a separate database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
function host(factory) {
  const context = vm.createContext({ indexedDB: factory, IDBKeyRange, URL, setTimeout, clearTimeout });
  for (const file of ['url-utils.js', 'quick-switcher-search.js', 'local-index.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return context.LaterOnLocalIndex;
}
const allowed = { bookmarkPermission: true, bookmarkConfig: { enabled: true, scopeId: null } };
const image = 'data:image/png;base64,QUJD';
const folders = [
  { id: '1', parentId: '0', title: 'Bar', protected: true, writable: false },
  { id: 'A', parentId: '1', title: 'Alpha', writable: true },
  { id: 'B', parentId: 'A', title: 'Beta', writable: true },
  { id: 'C', parentId: 'A', title: 'Gamma', writable: true }];
const page = (id, parentId, dateAdded) => ({ id, parentId, title: `Page ${id}`, url: `https://site.test/${id}?x=1#top`, dateAdded });
const pages = [
  ...Array.from({ length: 6 }, (_, i) => page(`a${i}`, 'A', 100 + i)),
  ...Array.from({ length: 6 }, (_, i) => page(`b${i}`, 'B', 200 + i)),
  ...Array.from({ length: 300 }, (_, i) => page(`c${i}`, 'C', 300 + i))];
const stateWith = (previews, updatedAt, extra = {}) => ({ enabled: true, scopeId: null, updatedAt, folders,
  nodes: [...folders, ...pages.map(node => previews[node.id] ? { ...node, preview: previews[node.id] } : node)], ...extra });
const record = (id, fields) => ({ id, url: pages.find(node => node.id === id).url, ...fields });
// Everything a reader can observe: totals, ordering, hierarchy, mosaics, text.
async function observe(store) {
  const seen = {};
  for (const [name, request] of Object.entries({ home: {}, folderA: { selected: 'A' }, folderB: { selected: 'B' }, folderC: { selected: 'C', limit: 500 },
    deep: { query: '深层摘要' }, unique: { query: 'zebra crossing' }, title: { query: 'page b3' }, short: { query: '摘' }, path: { query: 'alpha / beta', selected: 'A' } })) {
    const result = await store.bookmarkView({ limit: 12, ...request }, allowed);
    assert(result, `${name} is served`);
    seen[name] = plain({ view: result.view, nodes: result.nodes.filter(node => node.url), folders: result.folders.map(({ id, parentId, summary }) => ({ id, parentId,
      pages: summary.pages, folders: summary.folders, previewIds: summary.previewIds, previewImages: summary.previewImages, previews: summary.previews.map(node => node.id) })) });
  }
  return seen;
}
async function matchesFullBuild(store, previews, updatedAt, message) {
  const fresh = host(new IDBFactory());
  await fresh.putBookmarkState(stateWith(previews, updatedAt));
  assert.deepEqual(await observe(store), await observe(fresh), message);
}

(async () => {
  const factory = new IDBFactory();
  const store = host(factory);
  const previews = { b0: record('b0', { description: '旧的说明' }) };
  const first = await store.putBookmarkState(stateWith(previews, 10));
  assert.equal(first.applied, true);
  const startRevision = first.revision;
  let at = 10;
  async function apply(change, message) {
    const base = at; at += 10;
    for (const item of change.records || []) previews[item.id] = item;
    for (const id of change.removedIds || []) delete previews[id];
    const result = await store.patchBookmarkPreviews(change, { updatedAt: at, baseUpdatedAt: base, scopeId: null, signature: `s${at}` });
    assert.equal(result.applied, true, message);
    assert.equal((await store.info('bookmarks')).ready, true, 'A preview patch never marks the snapshot unready');
    await matchesFullBuild(store, previews, at, message);
    return result;
  }

  // First covers: a late page outranks earlier plain pages in every ancestor.
  await apply({ records: [record('c250', { image, description: '深层摘要 Zebra Crossing' })] }, 'A deep cover promotes through all ancestors');
  let home = await store.bookmarkView({ selected: 'A', limit: 12 }, allowed);
  assert.equal(home.folders.find(node => node.id === 'A').summary.previewIds[0], 'c250');
  assert.equal(home.folders.find(node => node.id === '1').summary.previewIds[0], 'c250');
  assert.equal(home.folders.find(node => node.id === 'A').summary.pages, 312, 'Counts are untouched');
  assert.equal((await store.bookmarkView({ query: 'zebra crossing' }, allowed)).view.totalPages, 1, 'A patched description is searchable through additive postings');

  await apply({ records: [record('a5', { image }), record('b4', { image }), record('c10', { image, description: '另一段深层摘要' })] }, 'A batch across folders');
  await apply({ records: [record('a1', { image }), record('a2', { image }), record('a3', { image }), record('a4', { image })] }, 'More covers than a mosaic holds');
  // Eviction: the next cover in native order fills the slot, not just a deletion.
  await apply({ removedIds: ['a1'] }, 'Evicting a shown cover promotes the next direct cover');
  await apply({ removedIds: ['a2', 'a3', 'a4', 'a5'] }, 'Evicting direct covers promotes descendant covers');
  await apply({ removedIds: ['b4', 'c10', 'c250'] }, 'With no covers left, native plain pages return');
  home = await store.bookmarkView({ selected: 'A', limit: 12 }, allowed);
  assert.deepEqual(plain(home.folders.find(node => node.id === 'B').summary.previewIds), ['b0', 'b1', 'b2']);
  assert.equal((await store.bookmarkView({ query: 'zebra crossing' }, allowed)).view.totalPages, 0, 'A removed description stops matching although stale postings remain');
  // Description rewrite and a non-image record.
  await apply({ records: [record('b0', { description: '新的说明' })] }, 'Replacing a description');
  assert.equal((await store.bookmarkView({ query: '旧的说明' }, allowed)).view.totalPages, 0);
  assert.equal((await store.bookmarkView({ query: '新的说明' }, allowed)).view.totalPages, 1);
  // A record for a URL the page no longer has is not attached, as in the mirror.
  const wrong = { id: 'b1', url: 'https://other.test/', image, description: 'wrong url' };
  const skipped = await store.patchBookmarkPreviews({ records: [wrong] }, { updatedAt: at + 10, baseUpdatedAt: at, scopeId: null });
  at += 10;
  assert.equal(skipped.applied, true);
  await matchesFullBuild(store, previews, at, 'A mismatched URL attaches nothing');
  const ghost = await store.patchBookmarkPreviews({ records: [{ id: 'gone', url: 'https://gone.test/', image }], removedIds: ['never-there', '1'] }, { updatedAt: at, baseUpdatedAt: at, scopeId: null });
  assert.equal(ghost.patched, 0, 'Records for deleted pages and folder ids are ignored');
  assert.equal((await store.info('bookmarks')).revision > startRevision, true, 'Revision is monotonic');

  // Guards: the patch must fit the stored snapshot.
  assert.equal(await store.patchBookmarkPreviews({ records: [] }, { updatedAt: at + 5, baseUpdatedAt: at - 1, scopeId: null }), false, 'A patch based on a missed state asks for a full build');
  assert.equal(await store.patchBookmarkPreviews({ records: [] }, { updatedAt: at + 5, baseUpdatedAt: at, scopeId: 'other' }), false, 'A different scope asks for a full build');
  assert.equal((await store.patchBookmarkPreviews({ records: [record('a0', { image })] }, { updatedAt: at - 5, scopeId: null })).stale, true, 'An older patch is skipped');
  await matchesFullBuild(store, previews, at, 'Rejected patches change nothing');

  // Failure: nothing commits, the old snapshot serves, and a retry succeeds.
  const before = await observe(store);
  const poison = record('a0', { image, description: 'poison', bad() {} });
  await assert.rejects(store.patchBookmarkPreviews({ records: [record('b5', { image, description: '不应保留' }), poison] }, { updatedAt: at + 10, baseUpdatedAt: at, scopeId: null }));
  assert.deepEqual(await observe(store), before, 'A failed patch commits nothing, including records before the failure');
  await apply({ records: [record('b5', { image, description: '重试成功' })] }, 'A patch succeeds after a failed one');
  const badState = stateWith(previews, at + 10);
  badState.nodes = [...badState.nodes, { ...page('bad', 'A', 1), bad() {} }];
  await assert.rejects(store.putBookmarkState(badState));
  assert.equal((await store.info('bookmarks')).ready, true);
  await matchesFullBuild(store, previews, at, 'A failed full build keeps the previous complete snapshot');
  at += 10;
  await store.putBookmarkState(stateWith(previews, at));
  await matchesFullBuild(store, previews, at, 'A full build succeeds after a failed one');

  // Readers are never refused while a delayed patch or a full build is running.
  const big = { enabled: true, scopeId: null, updatedAt: at + 100, folders,
    nodes: [...folders, ...Array.from({ length: 4000 }, (_, i) => page(`big${i}`, 'B', 1000 + i))] };
  const reads = [];
  let writing = true;
  const reader = (async () => { while (writing) {
    reads.push(await store.bookmarkView({ limit: 12 }, allowed));
    await new Promise(resolve => setTimeout(resolve, 0));
  } })();
  const patching = [];
  for (let i = 0; i < 5; i++) { const base = at; at += 1; patching.push(store.patchBookmarkPreviews({ records: [record(`c${i}`, { description: `批次 ${i}` })] }, { updatedAt: at, baseUpdatedAt: base, scopeId: null })); }
  assert((await Promise.all(patching)).every(result => result.applied), 'Patches issued together apply in order');
  await store.putBookmarkState({ ...big, updatedAt: at + 100 });
  writing = false; await reader;
  assert(reads.length > 3 && reads.every(Boolean), `No reader saw an unready snapshot (${reads.length} reads)`);
  assert.equal((await store.bookmarkView({ limit: 12 }, allowed)).view.totalPages, 4000);

  // Reverse order: older states lose, in-flight and across contexts.
  const race = host(new IDBFactory());
  const newest = stateWith({}, 500), older = stateWith({ b0: record('b0', { description: '旧状态' }) }, 400);
  const inFlightOld = race.putBookmarkState(older);
  const inFlightNew = race.putBookmarkState(newest);
  await assert.rejects(inFlightOld, /staleLocalIndex/, 'A superseded build stops without writing');
  assert.equal((await inFlightNew).updatedAt, 500);
  const reverse = await race.putBookmarkState(older);
  assert.equal(reverse.applied, false);
  assert.equal(reverse.stale, true);
  assert.equal((await race.info('bookmarks')).updatedAt, 500);
  assert.equal((await race.bookmarkView({ query: '旧状态' }, allowed)).view.totalPages, 0, 'An older state started last cannot win');
  const sharedFactory = new IDBFactory(), one = host(sharedFactory), two = host(sharedFactory);
  await one.putBookmarkState(newest);
  assert.equal((await two.putBookmarkState(older)).stale, true, 'A second context reads the stored revision before writing');
  assert.equal((await one.bookmarkView({ query: '旧状态' }, allowed)).view.totalPages, 0);

  // A patch landing while a newer full build is being prepared cannot outlive it.
  const pending = host(new IDBFactory());
  await pending.putBookmarkState(stateWith({}, 10));
  const building = pending.putBookmarkState(stateWith({}, 20));
  assert.notEqual(await pending.patchBookmarkPreviews({ records: [record('a0', { image })] }, { updatedAt: 20, baseUpdatedAt: 10, scopeId: null }), undefined);
  await building;
  assert.equal((await pending.bookmarkView({ selected: 'A' }, allowed)).nodes.find(node => node.id === 'a0').preview, undefined, 'The newer complete state decides the result');

  // Scoped snapshots: out-of-scope ancestors and path text behave as in a full build.
  const scopedAllowed = { bookmarkPermission: true, bookmarkConfig: { enabled: true, scopeId: 'A' } };
  const scopedState = (values, updatedAt) => ({ ...stateWith(values, updatedAt), scopeId: 'A' });
  const scoped = host(new IDBFactory());
  await scoped.putBookmarkState(scopedState({}, 1));
  const scopedRecord = record('b2', { image, description: '范围内摘要' });
  assert.equal((await scoped.patchBookmarkPreviews({ records: [scopedRecord] }, { updatedAt: 2, baseUpdatedAt: 1, scopeId: 'A' })).patched, 1);
  const scopedFresh = host(new IDBFactory());
  await scopedFresh.putBookmarkState(scopedState({ b2: scopedRecord }, 2));
  for (const request of [{}, { selected: 'A' }, { selected: 'B' }, { query: '范围内摘要' }, { query: 'alpha / beta' }, { query: 'bar / alpha' }]) {
    const content = async store => { const { revision, ...rest } = plain(await store.bookmarkView({ limit: 12, ...request }, scopedAllowed)); return rest; };
    assert.deepEqual(await content(scoped), await content(scopedFresh), `Scoped view ${JSON.stringify(request)}`);
  }

  // Membership: normalized key, native URL retained, query/fragment significant.
  const urls = host(new IDBFactory());
  const raw = 'HTTPS://Example.TEST:443/path?q=1#Part';
  await urls.putBookmarkState({ enabled: true, scopeId: null, updatedAt: 1, folders: [folders[0]], nodes: [folders[0], { id: 'u', parentId: '1', title: 'U', url: raw }] });
  const member = await urls.membership(['https://example.test/path?q=1#Part', 'https://EXAMPLE.test:443/path?q=1#Part', 'https://example.test/path?q=1#other', 'https://example.test/path', 'not a url'], allowed);
  assert.deepEqual(plain(member.matches), ['https://example.test/path?q=1#Part', 'https://EXAMPLE.test:443/path?q=1#Part'], 'Different spellings match and are returned as asked; query and fragment stay significant');
  assert.equal((await urls.bookmarkView({}, allowed)).nodes.find(node => node.id === 'u').url, raw, 'The native URL is returned unchanged');
  assert.equal((await urls.bookmarkView({}, allowed)).nodes.find(node => node.id === 'u').urlKey, undefined);
  console.log('PASS local index preview patch: identical to a full build across promotion/eviction/description changes, no unready reads, ordered writes, atomic failure and retry, normalized membership (simulated IndexedDB)');
})().catch(error => { console.error(error); process.exitCode = 1; });

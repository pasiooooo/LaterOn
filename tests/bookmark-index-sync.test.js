const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./bookmark-sync.test');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
// Source-mode preview maintenance intentionally starts after the 1.2-second
// first-screen lease. Leave headroom for that real delay and IDB publication.
const until = async (check, message) => { for (let i = 0; i < 1000 && !check(); i++) await tick(); assert(check(), message); };
const STATE = 'laterOnBookmarkState', META = 'laterOnBookmarkStateMeta', SEARCH = 'laterOnBookmarkSearchState';
function fakeIndex() {
  const index = { current: null, puts: [], patches: [], hold: null, failNext: false, patchFalse: false, commits: [],
    supported: () => true,
    async info(key) { return key === 'bookmarks' && index.current ? { ...index.current } : null; },
    async putBookmarkState(state, options = {}) {
      index.puts.push({ updatedAt: state.updatedAt, signature: options.signature, nodes: state.nodes });
      if (index.hold) await index.hold;
      if (options.isCurrent && !options.isCurrent()) throw Error('staleLocalIndex');
      if (index.failNext) { index.failNext = false; throw Error('IDB failed'); }
      if (index.current && index.current.updatedAt > state.updatedAt) return { ...index.current, applied: false, stale: true };
      index.current = { ready: true, updatedAt: state.updatedAt, scopeId: state.scopeId || null, signature: options.signature };
      index.commits.push(state.updatedAt);
      return { ...index.current, applied: true };
    },
    async patchBookmarkPreviews(changes, patch) {
      index.patches.push({ ...changes, ...patch });
      if (index.patchFalse || !index.current?.ready || index.current.updatedAt !== patch.baseUpdatedAt) return false;
      index.current = { ...index.current, updatedAt: patch.updatedAt, signature: patch.signature };
      index.commits.push(patch.updatedAt);
      return { ...index.current, applied: true };
    } };
  return index;
}
function watch(f) {
  const writes = [], messages = [], trees = { count: 0 };
  const set = f.chrome.storage.local.set, getTree = f.native.getTree;
  f.chrome.storage.local.set = async patch => { writes.push(Object.keys(patch)); return set(patch); };
  f.native.getTree = async (...args) => { trees.count++; return getTree(...args); };
  f.chrome.runtime.sendMessage = async message => { messages.push(message); };
  return { writes, messages, trees, wrote: key => writes.some(keys => keys.includes(key)), reset() { writes.length = 0; messages.length = 0; trees.count = 0; } };
}
(async () => {
  const f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null }, laterOnItems: [] });
  const index = fakeIndex(); f.ctx.LaterOnLocalIndex = index;
  const w = watch(f);
  vm.runInContext('globalThis.__realNow = Date.now; Date.now = (() => { const fixed = 1700000000000; return () => fixed; })()', f.ctx);
  f.grant(); await f.api.refresh(); await f.api.indexIdle();
  assert.equal(index.puts.length, 1, 'A published mirror is indexed once');
  assert.equal(index.current.updatedAt, f.store[META].updatedAt, 'The index records the source revision');
  assert(w.messages.some(message => message.type === 'BOOKMARKS_CHANGED' && message.updatedAt === index.current.updatedAt), 'Views are notified after the index commits');

  const firstAt = f.store[META].updatedAt;
  await f.chrome.bookmarks.create({ parentId: '2', title: 'Same clock', url: 'https://clock.test/' });
  await until(() => f.store[META].updatedAt !== firstAt, 'A native change publishes');
  assert.equal(f.store[META].updatedAt, firstAt + 1, 'Revisions stay monotonic when the clock does not move');
  await f.api.indexIdle();
  vm.runInContext('Date.now = globalThis.__realNow', f.ctx);

  // Preview-only batches patch the index without rewriting the large mirror.
  f.ctx.fetch = async () => new Response('<meta name="description" content="Fresh summary">', { headers: { 'content-type': 'text/html' } });
  await until(() => !!f.store.laterOnBookmarkPreviewQueue, 'Preview queue exists');
  w.reset(); index.puts.length = 0;
  const beforePreview = f.store[META].updatedAt, stateBefore = f.store[STATE];
  await f.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['outside'] });
  await until(() => index.patches.some(patch => patch.records.some(record => record.id === 'outside' && record.description === 'Fresh summary')), 'The preview batch is patched into the index');
  await f.api.indexIdle();
  assert.equal(w.wrote(STATE), false, 'A preview batch does not rewrite or broadcast the full mirror');
  assert.equal(w.wrote(SEARCH), false);
  assert.equal(f.store[STATE], stateBefore);
  assert.equal(index.puts.length, 0, 'No full index rebuild for preview-only changes');
  const patch = index.patches.find(entry => entry.records.some(record => record.id === 'outside'));
  assert.equal(patch.baseUpdatedAt, beforePreview);
  assert(patch.updatedAt > beforePreview && f.store[META].updatedAt === patch.updatedAt, 'The tiny meta record carries the new revision');
  assert(w.messages.some(message => message.type === 'BOOKMARKS_CHANGED' && message.updatedAt === patch.updatedAt));
  w.reset();
  const fullFallback = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert(fullFallback.nodes.some(node => node.id === 'outside' && node.preview?.description === 'Fresh summary'),
    'A full-view fallback includes preview updates that live outside the large mirror');
  assert.equal(fullFallback.updatedAt, f.store[META].updatedAt);
  assert.equal(w.trees.count, 0, 'Merging a fallback preview does not reread the native tree');
  assert.equal(w.wrote(STATE), false, 'A fallback response does not republish the large mirror');
  assert.equal(f.store[STATE], stateBefore);

  // A refresh after patched previews recognises the same structure and does not rewrite the mirror.
  w.reset();
  await f.api.refresh(); await f.api.indexIdle();
  assert.equal(w.wrote(STATE), false, 'Refreshing after a patch keeps the mirror untouched');
  assert.equal(index.puts.length, 0);

  // A patch the index cannot apply falls back to one full build that includes the cached preview.
  index.patchFalse = true;
  f.store.laterOnBookmarkPreviewQueue.attempted = {};
  f.ctx.fetch = async () => new Response('<meta name="description" content="Second summary">', { headers: { 'content-type': 'text/html' } });
  f.store.laterOnBookmarkPreviews.outside.attemptedAt -= 25 * 60 * 60 * 1000;
  await f.chrome.storage.local.set({ laterOnBookmarkPreviews: { ...f.store.laterOnBookmarkPreviews, outside: { ...f.store.laterOnBookmarkPreviews.outside, description: '', updatedAt: Date.now() } } });
  await f.api.refresh(); await f.api.indexIdle();
  index.puts.length = 0;
  await f.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['outside'] });
  await until(() => index.puts.length === 1, 'An unappliable patch schedules a full rebuild');
  await f.api.indexIdle();
  assert.equal(index.puts[0].updatedAt, f.store[META].updatedAt);
  assert(index.puts[0].nodes.some(node => node.id === 'outside' && node.preview?.description === 'Second summary'), 'The rebuild merges the current preview cache');
  index.patchFalse = false;

  // An older build still computing cannot commit over a newer one.
  let release;
  index.hold = new Promise(resolve => { release = resolve; });
  index.puts.length = 0; index.commits.length = 0;
  await f.chrome.bookmarks.create({ parentId: '2', title: 'Older', url: 'https://older.test/' });
  await until(() => index.puts.length === 1, 'The first build starts');
  await f.chrome.bookmarks.create({ parentId: '2', title: 'Newer', url: 'https://newer.test/' });
  await until(() => f.store[SEARCH].nodes.some(node => node.url === 'https://newer.test/'), 'The newer state publishes');
  release(); index.hold = null;
  await f.api.indexIdle(); await tick(); await f.api.indexIdle();
  assert.equal(index.commits.length, 1, 'Only the latest build commits');
  assert.equal(index.current.updatedAt, f.store[META].updatedAt, 'The index ends at the newest revision');

  // A failed build resets the check so the next cached open retries it.
  index.failNext = true; index.puts.length = 0;
  await f.chrome.bookmarks.create({ parentId: '2', title: 'Fails once', url: 'https://fails.test/' });
  await until(() => index.puts.length === 1, 'A build was attempted');
  await f.api.indexIdle();
  assert.notEqual(index.current.updatedAt, f.store[META].updatedAt, 'The failed build did not commit');
  await f.api.handle({ type: 'BOOKMARKS_GET' });
  await until(() => index.current.updatedAt === f.store[META].updatedAt, 'The next cached open rebuilds after failure');

  // A worker restart with an up-to-date index performs no build.
  const restarted = fixture(JSON.parse(JSON.stringify(f.store)));
  restarted.nodes.splice(0, restarted.nodes.length, ...JSON.parse(JSON.stringify(f.nodes)));
  const second = fakeIndex(); second.current = { ...index.current }; restarted.ctx.LaterOnLocalIndex = second;
  restarted.grant(); await tick();
  await restarted.api.handle({ type: 'BOOKMARKS_GET' }); await restarted.api.indexIdle(); await tick();
  assert.equal(second.puts.length, 0, 'A matching index is reused after restart');
  const stale = fixture(JSON.parse(JSON.stringify(f.store)));
  stale.nodes.splice(0, stale.nodes.length, ...JSON.parse(JSON.stringify(f.nodes)));
  const third = fakeIndex(); third.current = { ...index.current, updatedAt: index.current.updatedAt - 5 }; stale.ctx.LaterOnLocalIndex = third;
  stale.grant(); await tick();
  await stale.api.handle({ type: 'BOOKMARKS_GET' });
  await until(() => third.puts.length === 1 && third.current.updatedAt === stale.store[META].updatedAt, 'An older index is rebuilt once from the persisted mirror');
  // With the index available, an open view's preview request is bounded:
  // only the visible native nodes are read and the reply carries counts.
  {
    const quick = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' }, laterOnItems: [] });
    const qi = fakeIndex(); quick.ctx.LaterOnLocalIndex = qi;
    const qw = watch(quick);
    quick.grant(); await quick.api.refresh(); await quick.api.indexIdle();
    quick.store.laterOnBookmarkPreviewQueue = { pending: [], attempted: {}, visible: [], visibleKey: '' };
    let gets = 0; const get = quick.native.get;
    quick.native.get = async ids => { gets++; return get(ids); };
    qw.reset();
    const reply = await quick.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['inside', 'outside', 'missing'], viewKey: 'v1' });
    await tick(); await tick();
    assert.equal(qw.trees.count, 0, 'An open view never triggers a full native tree read');
    assert.equal(reply.visible, 1, 'Out-of-scope and missing ids are excluded by live ancestry');
    assert(gets <= 9, `Native reads stay proportional to visible ids and tree depth (${gets})`);
    assert(!('nodes' in reply) && !qw.wrote(STATE), 'No mirror is read back, sent or rewritten');
    quick.chrome.alarms.onAlarm.emit({ name: 'laterOnBookmarkPreviews' });
    await tick(); await tick();
    assert.equal(qw.trees.count, 0, 'An empty-queue wake returns before touching native bookmarks');
    quick.revoke(); await tick();
    await assert.rejects(quick.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['inside'] }), /bookmarkPermission/, 'Permission is checked live');
  }

  // The real device-local index on the actual publication path.
  let fake;
  try { fake = require('fake-indexeddb'); } catch {}
  if (fake) {
    const real = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null }, laterOnItems: [] });
    Object.assign(real.ctx, { indexedDB: new fake.IDBFactory(), IDBKeyRange: fake.IDBKeyRange });
    for (const file of ['url-utils.js', 'quick-switcher-search.js', 'local-index.js']) vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), real.ctx);
    const rw = watch(real), local = real.ctx.LaterOnLocalIndex;
    real.grant(); await real.api.refresh(); await real.api.indexIdle();
    const context = { bookmarkPermission: true, bookmarkConfig: { enabled: true, scopeId: null } };
    let info = await local.info('bookmarks');
    assert(info.ready && info.updatedAt === real.store[META].updatedAt, 'The real index commits the published revision');
    assert.deepEqual(Array.from((await local.membership(['https://outside.test/', 'https://none.test/'], context)).matches), ['https://outside.test/']);
    real.ctx.fetch = async () => new Response('<meta name="description" content="Indexed summary">', { headers: { 'content-type': 'text/html' } });
    rw.reset();
    await real.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['outside'] });
    await until(() => rw.messages.some(message => message.type === 'BOOKMARKS_CHANGED' && message.updatedAt === real.store[META].updatedAt && message.updatedAt > info.updatedAt), 'The real preview patch commits and notifies');
    await real.api.indexIdle();
    assert.equal(rw.wrote(STATE), false, 'The real patch path leaves the mirror untouched');
    info = await local.info('bookmarks');
    assert(info.ready && info.updatedAt === real.store[META].updatedAt);
    const view = await local.bookmarkView({ query: 'indexed summary' }, context);
    assert(view.nodes.some(node => node.id === 'outside' && node.preview?.description === 'Indexed summary'), 'The patched description is searchable in the bounded view');
  }
  console.log('PASS bookmark index sync: monotonic revisions, preview patches without mirror rewrite, unappliable-patch rebuild, latest-build-wins, failure retry and restart reuse');
})().catch(error => { console.error(error); process.exitCode = 1; });

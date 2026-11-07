// Manual preview loading with the device-local index: every access check is a
// bounded native read, the complete tree is read once per batch to commit, and
// the large Chrome mirrors are never read. A change in permission, scope, URL
// or preview generation cancels the work; cached data never grants access.
// Fake IndexedDB and native APIs: behavior and read counts, never Chrome timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const fixture = require('./bookmark-sync.test');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const PREVIEWS = 'laterOnBookmarkPreviews';
const allowed = scopeId => ({ bookmarkPermission: true, bookmarkConfig: { enabled: true, scopeId } });
const html = text => new Response(`<html><head><meta name="description" content="${text}"></head></html>`, { headers: { 'content-type': 'text/html' } });

// `hold` stops the next page fetch until released, so a test can act while the
// manual batch is in its load phase.
async function indexed(scopeId = 'scope', cached = null) {
  const f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId }, laterOnItems: [], ...(cached ? { [PREVIEWS]: cached } : {}) });
  Object.assign(f.ctx, { indexedDB: new IDBFactory(), IDBKeyRange });
  for (const file of ['url-utils.js', 'quick-switcher-search.js', 'local-index.js']) vm.runInContext(read(file), f.ctx);
  const counts = { trees: 0, gets: 0, fetches: [] };
  const tree = f.native.getTree.bind(f.native), get = f.native.get.bind(f.native);
  f.native.getTree = async () => { counts.trees++; return tree(); };
  f.native.get = async ids => { counts.gets++; return get(ids); };
  const storageGet = f.chrome.storage.local.get.bind(f.chrome.storage.local);
  f.chrome.storage.local.get = async keys => {
    const list = Array.isArray(keys) ? keys : [keys];
    assert(!list.includes('laterOnBookmarkState') && !list.includes('laterOnBookmarkSearchState'), 'Manual previews never read a large Chrome mirror');
    return storageGet(keys);
  };
  f.chrome.storage.local.remove = async keys => { for (const key of [].concat(keys)) delete f.store[key]; };
  f.chrome.runtime.sendMessage = async () => ({ ok: true });
  f.grant();
  await f.api.refresh(); await f.api.indexIdle();
  let gate = null, reached = null;
  f.ctx.fetch = async url => {
    counts.fetches.push(url);
    if (gate) { const wait = gate; gate = null; reached(); await wait; }
    return html('Fetched summary');
  };
  return { f, counts, view: query => f.ctx.LaterOnLocalIndex.bookmarkView({ query }, allowed(scopeId)),
    hold() {
      let release; gate = new Promise(resolve => { release = resolve; });
      const arrived = new Promise(resolve => { reached = resolve; });
      return { arrived, release: () => release() };
    },
    reset() { counts.trees = 0; counts.gets = 0; counts.fetches.length = 0; } };
}
const load = (f, ids) => f.api.handle({ type: 'BOOKMARKS_PREVIEWS', ids });
const cachedFor = (f, id) => f.store[PREVIEWS]?.[id];
async function cancelled(setup, change, message) {
  const t = await indexed(...setup);
  t.reset();
  const held = t.hold(), running = load(t.f, ['inside']);
  await held.arrived;
  await change(t);
  held.release();
  const reply = await running;
  await t.f.api.indexIdle();
  assert.equal(reply.previewResults?.updated ?? 0, 0, `${message}: nothing is reported as updated`);
  assert.equal(cachedFor(t.f, 'inside'), undefined, `${message}: the fetched preview is not cached`);
  return { t, reply };
}

(async () => {
  // A successful batch: bounded reads while loading, one tree read to commit.
  const ok = await indexed();
  ok.reset();
  const held = ok.hold(), running = load(ok.f, ['inside']);
  await held.arrived;
  assert.equal(ok.counts.trees, 0, 'The start of a manual batch reads no tree');
  assert(ok.counts.gets > 0, 'Access is checked with bounded native reads');
  held.release();
  const reply = await running;
  assert.equal(ok.counts.trees, 1, 'A batch reads the complete tree exactly once, to commit and prune');
  assert.equal(reply.previewResults.updated, 1);
  assert.equal(reply.previewResults.failed, 0);
  assert.equal(reply.nodes, undefined, 'An indexed batch replies with small metadata instead of the mirror');
  assert.equal(reply.source, 'indexeddb');
  assert.equal(cachedFor(ok.f, 'inside').description, 'Fetched summary');
  await ok.f.api.indexIdle();
  const found = await ok.view('fetched summary');
  assert.deepEqual(JSON.parse(JSON.stringify(found.nodes.filter(node => node.url).map(node => node.id))), ['inside'], 'The preview is searchable from the patched index');
  assert.equal(found.nodes.find(node => node.id === 'inside').preview.description, 'Fetched summary');
  assert.equal(ok.f.store.laterOnBookmarkState, undefined, 'No large mirror is written');
  assert.equal(ok.f.store.laterOnBookmarkSearchState, undefined);

  // Requests are validated before any page is fetched.
  const strict = await indexed();
  strict.reset();
  await assert.rejects(load(strict.f, ['outside']), /bookmarkOutOfScope/, 'A page outside the live scope is refused');
  await assert.rejects(load(strict.f, ['inside', 'outside']), /bookmarkOutOfScope/, 'One refused id refuses the whole batch');
  await assert.rejects(load(strict.f, ['missing']), /bookmarkOutOfScope/, 'A deleted id is refused');
  await assert.rejects(load(strict.f, [7]), /bookmarkInvalidItems/);
  assert.equal(strict.counts.fetches.length, 0, 'A refused batch fetches nothing');
  assert.equal(strict.counts.trees, 0, 'A refused batch reads no tree');
  const folders = await load(strict.f, ['nested', 'inside']);
  assert.equal(folders.previewResults.updated, 1, 'A folder in the batch is skipped, the page is loaded');
  assert.equal(strict.counts.fetches.length, 1, 'Only the page is fetched');
  strict.reset();
  for (let i = 0; i < 15; i++) strict.f.nodes.push({ id: `extra${i}`, parentId: 'scope', title: `Extra ${i}`, url: `https://extra.test/${i}` });
  await load(strict.f, Array.from({ length: 15 }, (_, i) => `extra${i}`));
  assert.equal(strict.counts.fetches.length, 12, 'A batch loads at most twelve pages');
  assert.equal(strict.counts.trees, 1);

  // Old state never grants access. The cached cover source belongs to a URL
  // the bookmark no longer has; an out-of-scope cache entry stays out of scope.
  const stale = await indexed('scope', { outside: { id: 'outside', url: 'https://outside.test', description: 'Old', sourceImage: 'https://images.test/outside.png' },
    inside: { id: 'inside', url: 'https://old.test/page', description: 'Old', sourceImage: 'https://images.test/private.png' } });
  stale.reset();
  await assert.rejects(load(stale.f, ['outside']), /bookmarkOutOfScope/, 'A cached preview does not authorize an out-of-scope page');
  assert.equal(stale.counts.fetches.length, 0);
  await load(stale.f, ['inside']);
  assert(!stale.counts.fetches.some(url => url.includes('private.png')), 'A cached source image for another URL is not requested');
  assert.equal(cachedFor(stale.f, 'inside').url, 'https://example.com/paper');

  // Scope and index facts are re-read live: a removed scope is refused even
  // though the published snapshot still lists the page.
  const gone = await indexed();
  gone.reset();
  gone.f.nodes.splice(gone.f.nodes.findIndex(node => node.id === 'scope'), 1);
  await assert.rejects(load(gone.f, ['inside']), /bookmarkScopeMissing/, 'A removed scope is refused before any page is fetched');
  assert.equal(gone.counts.fetches.length, 0);

  // Changes during the load phase cancel the batch.
  const revoked = await cancelled([], ({ f }) => { f.revoke(); }, 'Revoked permission');
  assert.equal(revoked.reply.previewResults.cancelled, true);
  const generation = await cancelled([], ({ f }) => { f.ctx.LaterOnBookmarkPreviews.cancel(); }, 'A new preview generation');
  assert.equal(generation.reply.previewResults.cancelled, true);
  const scope = await cancelled([], ({ f }) => { f.store.laterOnBookmarkConfig = { enabled: true, scopeId: 'nested' }; }, 'A changed scope');
  assert.equal(scope.reply.previewResults.failed, 1);
  const moved = await cancelled([], ({ f }) => { f.nodes.find(node => node.id === 'inside').parentId = '2'; }, 'A page moved out of scope');
  assert.equal(moved.reply.previewResults.failed, 1);
  // No native event: only the live checks can notice this URL change.
  const url = await cancelled([], ({ f }) => { f.nodes.find(node => node.id === 'inside').url = 'https://changed.test/'; }, 'A changed URL');
  assert.equal(url.reply.previewResults.failed, 1);
  assert.equal((await url.t.view('fetched summary')).view.totalPages, 0, 'A cancelled preview never reaches the index');

  // Without the device-local index the full mirror is still published.
  const legacy = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' }, laterOnItems: [] });
  legacy.grant();
  legacy.ctx.fetch = async () => html('Legacy summary');
  const full = await load(legacy, ['inside']);
  assert.equal(full.previewResults.updated, 1);
  assert.equal(full.nodes.find(node => node.id === 'inside').preview.description, 'Legacy summary', 'The legacy reply keeps the full mirror');
  console.log('PASS bookmark manual previews: bounded guards with one commit-time tree read, no mirror reads, indexed search of the result, strict batch validation, cached data grants nothing, and permission/scope/URL/generation changes cancel (simulated native APIs and IndexedDB)');
  await tick();
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });

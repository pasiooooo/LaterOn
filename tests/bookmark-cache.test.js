const assert = require('node:assert/strict');
const fixture = require('./bookmark-sync.test');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const STATE = 'laterOnBookmarkState', META = 'laterOnBookmarkStateMeta', SEARCH = 'laterOnBookmarkSearchState';
function spy(f) {
  const writes = [], trees = { count: 0 };
  const set = f.chrome.storage.local.set, getTree = f.native.getTree;
  f.chrome.storage.local.set = async patch => { writes.push(Object.keys(patch)); return set(patch); };
  f.native.getTree = async (...args) => { trees.count++; return getTree(...args); };
  return { writes, trees, wrote: key => writes.some(keys => keys.includes(key)), reset() { writes.length = 0; trees.count = 0; } };
}
(async () => {
  const f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null } });
  f.grant(); await f.api.refresh();
  const first = f.store[STATE];
  assert(f.store[META]?.signature && f.store[SEARCH], 'Publishing writes the mirror, its tiny revision record and the lean search mirror');
  assert(f.store[SEARCH].nodes.every(node => !('preview' in node)), 'The search mirror carries no preview payload');
  assert.equal(f.store[SEARCH].nodes.length, first.nodes.length);

  const watch = spy(f);
  await f.api.refresh();
  assert.equal(watch.wrote(STATE), false, 'An unchanged native tree does not rewrite or broadcast the mirror');
  assert.equal(watch.wrote(SEARCH), false);
  assert.equal(f.store[STATE].updatedAt, first.updatedAt, 'The revision time stays stable while content is unchanged');

  watch.reset();
  let state = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(watch.trees.count, 0, 'Opening a view returns the matching cached mirror without reading the native tree');
  assert.equal(watch.writes.length, 0);
  assert.equal(state.nodes.length, first.nodes.length);
  state = await f.api.handle({ type: 'BOOKMARKS_GET', force: true });
  assert.equal(watch.trees.count, 1, 'An explicit refresh still reads native bookmarks');

  watch.reset();
  f.store[META].checkedAt -= 2 * 60 * 1000;
  await f.api.handle({ type: 'BOOKMARKS_GET' });
  await settle();
  assert.equal(watch.trees.count, 1, 'An old check schedules one quiet verification behind the cached reply');
  assert.equal(watch.wrote(STATE), false, 'Verification of unchanged content writes only the tiny check record');
  assert(watch.wrote(META));

  watch.reset();
  const probe = await f.api.handle({ type: 'BOOKMARKS_CHECK' });
  assert.equal(watch.trees.count, 0, 'A fresh check record makes the probe free');
  assert.deepEqual(Object.keys(probe).sort(), ['changed', 'checkedAt', 'enabled', 'error', 'scopeId', 'signature', 'updatedAt']);
  const forced = await f.api.handle({ type: 'BOOKMARKS_CHECK', force: true });
  assert.equal(watch.trees.count, 1);
  assert.equal(forced.changed, false);

  watch.reset();
  await f.chrome.bookmarks.create({ parentId: '2', title: 'New page', url: 'https://new.test/a#part' });
  await settle();
  assert(watch.wrote(STATE) && watch.wrote(SEARCH), 'Native events still publish real changes');
  assert(f.store[META].signature !== first.signature);
  assert(f.store[SEARCH].nodes.some(node => node.url === 'https://new.test/a#part'));

  const preview = { ...(f.store.laterOnBookmarkPreviews || {}), outside: { url: 'https://outside.test', description: 'Cached summary', updatedAt: Date.now() } };
  await f.chrome.storage.local.set({ laterOnBookmarkPreviews: preview });
  watch.reset();
  await f.api.refresh();
  assert(watch.wrote(STATE), 'A changed preview updates the full mirror for the existing UI');
  assert.equal(watch.wrote(SEARCH), false, 'Preview-only changes leave the lean search mirror untouched');

  const members = await f.api.handle({ type: 'BOOKMARKS_MEMBERSHIP', urls: ['https://new.test/a#part', 'https://new.test/a#other', 'https://NEW.test:443/a#part', 'https://missing.test/', 'javascript:alert(1)'] });
  assert.deepEqual(Array.from(members.matches), ['https://new.test/a#part'], 'Membership answers only the asked URLs with exact serialized identity');
  assert.equal(members.valid, true);
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_MEMBERSHIP', urls: 'https://new.test/' }), /bookmarkInvalidItems/);
  const many = await f.api.handle({ type: 'BOOKMARKS_MEMBERSHIP', urls: [...Array.from({ length: 250 }, (_, i) => `https://x.test/${i}`), 'https://new.test/a#part'] });
  assert.equal(many.matches.length, 0, 'At most 200 URLs are examined per request');

  f.store.laterOnBookmarkConfig = { enabled: true, scopeId: 'scope' };
  assert.equal((await f.api.handle({ type: 'BOOKMARKS_MEMBERSHIP', urls: ['https://outside.test/'] })).valid, false, 'A mirror for another scope answers nothing');
  watch.reset();
  state = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(watch.trees.count, 1, 'A scope mismatch is rebuilt live, never served from cache');
  assert.equal(state.scopeId, 'scope');
  assert(!state.nodes.some(node => node.id === 'outside'));
  f.revoke(); await settle();
  state = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(state.error, 'bookmarkPermission', 'Revoked permission is checked before cached data is returned');
  assert.equal((await f.api.handle({ type: 'BOOKMARKS_MEMBERSHIP', urls: ['https://example.com/paper'] })).matches.length, 0);

  const stored = JSON.parse(JSON.stringify(f.store));
  const restarted = fixture(stored);
  const restartWatch = spy(restarted);
  await settle();
  assert.equal(restartWatch.trees.count, 0, 'Loading the worker performs no full bookmark refresh');
  assert.equal(restartWatch.writes.length, 0);
  let checks = 0;
  const contains = restarted.chrome.permissions.contains;
  restarted.chrome.permissions.contains = async (...args) => { checks++; return contains(...args); };
  restarted.chrome.runtime.onStartup.emit();
  await settle();
  assert(checks > 0, 'Browser startup still re-establishes the mirror');
  assert.equal(restartWatch.writes.length, 0, 'An identical permission-error mirror is not rewritten');

  const big = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' } });
  let parent = 'scope';
  for (let depth = 0; depth < 12; depth++) { const id = `deep-${depth}`; big.nodes.push({ id, parentId: parent, title: `Level ${depth}`, children: [] }); parent = id; }
  for (let i = 0; i < 20000; i++) big.nodes.push({ id: `page-${i}`, parentId: i % 2 ? parent : '2', title: `Page ${i}`, url: `https://bulk.test/${i}` });
  big.grant(); await settle();
  const started = Date.now();
  state = await big.api.handle({ type: 'BOOKMARKS_GET', force: true });
  const elapsed = Date.now() - started;
  assert.equal(state.nodes.filter(node => node.url?.startsWith('https://bulk.test/')).length, 10000);
  assert(elapsed < 3000, `Scoped refresh of 20,000 bookmarks stays linear (${elapsed} ms)`);
  console.log(`PASS bookmark cache: no wake refresh, cached GET with scope/permission checks, quiet rechecks, unchanged skip, lean search mirror, bounded membership and linear scope (${elapsed} ms for 20k)`);
})().catch(error => { console.error(error); process.exitCode = 1; });

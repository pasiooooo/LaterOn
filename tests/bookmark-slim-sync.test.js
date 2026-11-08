const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const fixture = require('./bookmark-sync.test');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const event = () => ({ addListener() {} });
function installIndex(f, database) {
  Object.assign(f.ctx, { indexedDB: database, IDBKeyRange });
  for (const file of ['url-utils.js', 'quick-switcher-modes.js', 'quick-switcher-search.js', 'local-index.js']) vm.runInContext(read(file), f.ctx);
  f.native.getChildren = async id => f.nodes.filter(n => n.parentId === id);
  f.native.getRecent = async count => f.nodes.filter(n => n.url).slice().reverse().slice(0, count);
  f.native.search = async query => f.nodes.filter(n => n.url && (typeof query === 'object'
    ? new URL(n.url).href === new URL(query.url).href : `${n.title} ${n.url}`.includes(query)));
  const get = f.chrome.storage.local.get.bind(f.chrome.storage.local), set = f.chrome.storage.local.set.bind(f.chrome.storage.local);
  const gets = [], writes = [];
  f.chrome.storage.local.get = async keys => {
    const list = Array.isArray(keys) ? keys : [keys]; gets.push(...list);
    assert(!list.includes('laterOnBookmarkState') && !list.includes('laterOnBookmarkSearchState'), 'Indexed source never reads either large Chrome mirror');
    return get(keys);
  };
  f.chrome.storage.local.set = async values => {
    writes.push(...Object.keys(values));
    assert(!('laterOnBookmarkState' in values) && !('laterOnBookmarkSearchState' in values), 'Native updates never broadcast either large Chrome mirror');
    return set(values);
  };
  f.chrome.storage.local.remove = async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete f.store[key]; };
  f.chrome.runtime.sendMessage = async () => ({ ok: true });
  return { gets, writes };
}

(async () => {
  const database = new IDBFactory(), f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null } });
  const observed = installIndex(f, database);
  f.grant();
  const published = await f.api.refresh();
  await f.api.indexIdle();
  assert(published.nodes.some(n => n.id === 'inside'));
  assert.equal(f.store.laterOnBookmarkStateMeta.source, 'indexeddb');
  assert(f.store.laterOnBookmarkStateMeta.nativeVerifiedAt > 0, 'Successful snapshots publish their verification in the same metadata record');
  assert.equal(f.store.laterOnBookmarkState, undefined);
  const source = await f.api.searchSource();
  assert(source.nodes.some(n => n.id === 'inside' && n.url === 'https://example.com/paper'));
  assert(!JSON.stringify(source).includes('image'));

  const history = { pending: [], attempted: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`old${i}`, { url: `https://old.test/${i}`, at: 1, complete: false }])) };
  await f.chrome.storage.local.set({ laterOnBookmarkPreviewQueue: history });
  observed.gets.length = 0; observed.writes.length = 0;
  const verified = f.store.laterOnBookmarkStateMeta.nativeVerifiedAt;
  const answer = await f.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['inside'], viewKey: 'first' });
  assert.equal(answer.visible, 1); assert.equal(answer.deferred, true);
  assert(!observed.gets.includes('laterOnBookmarkPreviewQueue'), 'First-screen priority does not deserialize the retry history');
  assert(observed.writes.every(k => k === 'laterOnBookmarkPreviewVisible'));
  assert.equal(f.store.laterOnBookmarkStateMeta.nativeVerifiedAt, verified, 'An immediate preview announcement does not claim a new native snapshot');

  const seed = JSON.parse(JSON.stringify(f.store));
  seed.laterOnBookmarkStateMeta.nativeVerifiedAt = 0;
  const nativeAt = Date.now() - 1;
  seed.laterOnQuickSearchPending = { revision: Date.now(), bookmarks: true, nativeAt, nativeIds: ['inside'] };
  // A fresh worker inherits the persisted database/marker, but none of the old
  // onNativeChange call stack. Any successful forced snapshot repairs it.
  const restarted = fixture(seed);
  installIndex(restarted, database);
  restarted.chrome.permissions.onAdded.listeners = [];
  restarted.grant();
  await restarted.api.handle({ type: 'BOOKMARKS_GET', force: true });
  await restarted.api.indexIdle();
  assert(restarted.store.laterOnBookmarkStateMeta.nativeVerifiedAt >= nativeAt);
  restarted.chrome.tabs = { onRemoved: event(), onActivated: event(), async query() { return []; } };
  restarted.chrome.windows = {};
  vm.runInContext(read('quick-switcher-background.js'), restarted.ctx);
  await restarted.ctx.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_SEARCH', query: 'Paper' }, { url: 'chrome-extension://fixture/library.html' });
  let ready = null;
  for (let i = 0; i < 200; i++) {
    ready = await restarted.ctx.LaterOnLocalIndex.info();
    if (ready?.ready && !ready.pending && !restarted.store.laterOnQuickSearchPending) break;
    await tick();
  }
  assert(ready?.ready && !ready.pending && !restarted.store.laterOnQuickSearchPending, 'Restarted Quick finishes and clears the marker after snapshot verification');
  const held = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null } });
  installIndex(held, new IDBFactory());
  let release, trees = 0;
  const gate = new Promise(resolve => { release = resolve; }), nativeTree = held.native.getTree.bind(held.native);
  held.native.getTree = async () => { trees++; return nativeTree(); };
  const originalPut = held.ctx.LaterOnLocalIndex.putBookmarkState;
  held.ctx.LaterOnLocalIndex.putBookmarkState = async (...args) => { await gate; return originalPut(...args); };
  held.grant(); await held.api.refresh();
  const beforeViews = trees;
  for (let i = 0; i < 3; i++) await held.api.handle({ type: 'BOOKMARKS_VIEW', limit: 12 });
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(trees, beforeViews, 'Provisional views never start a second native scan while a build is running');
  release(); await held.api.indexIdle();
  assert((await held.ctx.LaterOnLocalIndex.info('bookmarks'))?.ready, 'The held build completes once, without refresh feedback cancelling it');

  // A real upgrade has enabled config and old mirrors, but no new metadata.
  // A previously published Reading-only index must not hide native bookmarks.
  const upgrade = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null },
    laterOnBookmarkState: { enabled: true, nodes: [{ id: 'inside', title: 'Paper', url: 'https://example.com/paper' }], folders: [] } });
  installIndex(upgrade, new IDBFactory());
  upgrade.chrome.permissions.onAdded.listeners = []; upgrade.grant();
  assert.equal(await upgrade.api.searchSource(), null, 'Missing upgrade META is an unavailable source, never disabled bookmarks');
  await upgrade.ctx.LaterOnLocalIndex.putSearchSource({ laterOnItems: upgrade.store.laterOnItems,
    laterOnBookmarkConfig: upgrade.store.laterOnBookmarkConfig, laterOnBookmarkSearchState: { enabled: false, nodes: [], folders: [] } }, 1);
  upgrade.chrome.tabs = { onRemoved: event(), onActivated: event(), async query() { return []; } };
  upgrade.chrome.windows = {};
  vm.runInContext(read('quick-switcher-background.js'), upgrade.ctx);
  const sender = { url: 'chrome-extension://fixture/library.html' };
  await upgrade.ctx.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_ACTIVITY', active: true }, sender);
  const firstUpgrade = await upgrade.ctx.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_SEARCH', query: 'Paper' }, sender);
  assert.equal(firstUpgrade.provisional, true, 'Reading-only snapshots cannot claim a complete bookmark search');
  assert(firstUpgrade.results.some(row => row.bookmarkIds.includes('inside')), 'Upgrade bootstrap finds and validates real native bookmarks');
  assert.equal((await upgrade.ctx.LaterOnLocalIndex.info()).bookmarkEnabled, false, 'The held first-use dialog has not caused a full rebuild');
  await upgrade.api.handle({ type: 'BOOKMARKS_GET', force: true });
  await upgrade.ctx.LaterOnQuickSwitcher.handle({ type: 'QUICK_SWITCHER_ACTIVITY', active: false }, sender);
  for (let i = 0; i < 300; i++) {
    const prepared = await upgrade.ctx.LaterOnLocalIndex.info();
    if (prepared?.bookmarkEnabled && !prepared.pending && !upgrade.store.laterOnQuickSearchPending) break;
    await tick();
  }
  assert((await upgrade.ctx.LaterOnLocalIndex.info())?.bookmarkEnabled && !upgrade.store.laterOnQuickSearchPending, 'Upgrade maintenance publishes combined search and clears its marker');
  await upgrade.chrome.storage.local.set({ laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' } });
  assert.equal(await upgrade.api.searchSource(), null, 'An old-scope META cannot publish a complete source for the new scope');

  // Foreground native actions complete even with an unrelated Quick dialog
  // active, including when background work already holds the shared queue.
  const urgent = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null } });
  installIndex(urgent, new IDBFactory());
  urgent.chrome.permissions.onAdded.listeners = []; urgent.grant();
  await urgent.api.refresh(); await urgent.api.indexIdle();
  let active = false, started;
  urgent.ctx.LaterOnQuickSwitcher = { isInteractive: () => active };
  const began = new Promise(resolve => { started = resolve; });
  const tree = urgent.native.getTree.bind(urgent.native);
  urgent.native.getTree = async () => { const nodes = await tree(); active = true; started(); return nodes; };
  urgent.chrome.runtime.onStartup.emit();
  await Promise.race([began, new Promise((_, reject) => setTimeout(() => reject(Error('Scheduled background refresh did not start')), 3000))]);
  const forced = await Promise.race([urgent.api.handle({ type: 'BOOKMARKS_GET', force: true }),
    new Promise((_, reject) => setTimeout(() => reject(Error('Foreground refresh was blocked by a background activity wait')), 700))]);
  assert(forced.nodes.some(node => node.id === 'inside'));
  const updated = await Promise.race([urgent.api.handle({ type: 'BOOKMARKS_UPDATE', id: 'inside', title: 'Immediate edit' }),
    new Promise((_, reject) => setTimeout(() => reject(Error('A committed native edit waited for the dialog activity lease')), 700))]);
  assert(updated.committed && updated.nodes.some(node => node.title === 'Immediate edit'));
  urgent.native.getTree = tree;
  active = false;
  await urgent.api.indexIdle();

  // Cancellation can finish unwinding after the activity has ended. The
  // current job still needs retrying; catch-time activity is not its identity.
  const cancelled = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null } });
  installIndex(cancelled, new IDBFactory());
  cancelled.chrome.permissions.onAdded.listeners = []; cancelled.grant();
  const put = cancelled.ctx.LaterOnLocalIndex.putBookmarkState;
  let tries = 0;
  cancelled.ctx.LaterOnLocalIndex.putBookmarkState = async (...args) => {
    if (++tries === 1) throw Error('staleLocalIndex');
    return put(...args);
  };
  await cancelled.api.refresh(); await cancelled.api.indexIdle();
  assert.equal(tries, 2, 'A current cancelled job is requeued even after activity ended');
  assert((await cancelled.ctx.LaterOnLocalIndex.info('bookmarks'))?.ready);
  console.log('PASS indexed native sync: metadata-only publication, tiny preview announcements, restart and upgrade recovery, urgent native actions and cancelled-build retry (simulated Chrome/IndexedDB)');
})().catch(error => { console.error(error); process.exitCode = 1; });

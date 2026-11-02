const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => JSON.parse(JSON.stringify(value));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, hasListener(fn) { return this.listeners.includes(fn); }, removeListener(fn) { this.listeners = this.listeners.filter(entry => entry !== fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
function fixture(initial = {}, noNamespace = false, blockedListeners = false) {
  const store = { laterOnItems: [{ id: 'reading', title: 'Research', url: 'https://example.com/paper', status: 'done' }], ...clone(initial) };
  let granted = false, nextId = 100, fail = false;
  const nodes = [
    { id: '0', title: '', children: [] },
    { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [] },
    { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
    { id: 'scope', parentId: '1', title: 'Research', children: [] },
    { id: 'nested', parentId: 'scope', title: 'Nested', children: [] },
    { id: 'inside', parentId: 'scope', title: 'Paper', url: 'https://example.com/paper' },
    { id: 'outside', parentId: '2', title: 'Outside', url: 'https://outside.test' },
    { id: 'managed', parentId: '1', title: 'Managed', unmodifiable: 'managed', children: [] },
    { id: 'policy', parentId: 'managed', title: 'Policy', url: 'https://policy.test' }
  ];
  const events = Object.fromEntries(['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded'].map(name => [name, event()]));
  if (blockedListeners) for (const api of Object.values(events)) {
    const add = api.addListener.bind(api);
    api.addListener = fn => { if (!granted) throw new Error('Permission required for listener'); add(fn); };
  }
  const changed = event();
  const native = {
    ...events,
    async getTree() {
      if (!granted) throw new Error('Permission denied');
      if (fail) { fail = false; throw new Error('Fixture failure'); }
      const copies = clone(nodes).map(node => { if (!node.url) node.children = []; return node; });
      const byId = new Map(copies.map(node => [node.id, node]));
      for (const node of copies) if (node.parentId) byId.get(node.parentId)?.children.push(node);
      return [byId.get('0')];
    },
    async create(data) {
      const node = { id: String(nextId++), ...clone(data), ...(data.url ? {} : { children: [] }) };
      nodes.push(node); events.onCreated.emit(node.id, node); return clone(node);
    },
    async update(id, patch) { const node = nodes.find(node => node.id === id); Object.assign(node, patch); events.onChanged.emit(id, patch); return clone(node); },
    async move(id, patch) { const node = nodes.find(node => node.id === id); const oldParentId = node.parentId; Object.assign(node, patch); events.onMoved.emit(id, { oldParentId, ...patch }); return clone(node); },
    async remove(id) { const index = nodes.findIndex(node => node.id === id); if (nodes.some(node => node.parentId === id)) throw new Error('Not empty'); const [node] = nodes.splice(index, 1); events.onRemoved.emit(id, { parentId: node.parentId, node }); }
  };
  const chrome = {
    bookmarks: noNamespace ? undefined : native,
    permissions: { async contains() { return granted; }, onAdded: event(), onRemoved: event() },
    storage: { local: {
      async get(keys) { return clone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]]))); },
      async set(patch) { Object.assign(store, clone(patch)); changed.emit(Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, { newValue: value }])), 'local'); },
      async remove(keys) { for (const key of keys) delete store[key]; }
    }, onChanged: changed },
    runtime: { onMessage: event(), onStartup: event(), onInstalled: event(), getURL: p => `chrome-extension://fixture/${p}` },
    alarms: { create() {}, clear() {}, onAlarm: event() }
  };
  const ctx = vm.createContext({ chrome, URL, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../bookmark-sync.js'), 'utf8'), ctx);
  return { store, nodes, chrome, native, ctx, api: ctx.LaterOnBookmarkSync, grant() { granted = true; chrome.permissions.onAdded.emit({ permissions: ['bookmarks'] }); }, revoke() { granted = false; chrome.permissions.onRemoved.emit({ permissions: ['bookmarks'] }); }, fail() { fail = true; } };
}
async function run() {
  const f = fixture();
  let state = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(state.enabled, false, 'Disabled by default; never modifies native bookmarks');
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: true }), /bookmarkPermission/);
  f.grant();
  state = await f.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: null });
  assert.equal(state.scopeId, null);
  assert(state.nodes.some(node => node.id === 'outside'));
  const beforeReading = clone(f.store.laterOnItems);
  state = await f.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: 'scope' });
  assert(state.nodes.some(node => node.id === 'nested'));
  assert(!state.nodes.some(node => node.id === 'outside'));
  assert.equal(f.nodes.length, 9, 'Scope changes must never delete native nodes');
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_REMOVE', id: 'outside' }), /bookmarkOutOfScope/);
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_CREATE', parentId: '2', title: 'No', url: 'https://no.test' }), /bookmarkOutOfScope/);
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: 'inside' }), /bookmarkFolderRequired/);
  assert.equal(f.store.laterOnBookmarkConfig.scopeId, 'scope', 'Rejected scope leaves old config intact');
  state = await f.api.handle({ type: 'BOOKMARKS_CREATE', parentId: 'nested', title: 'Created', url: 'https://created.test' });
  const created = state.nodes.find(node => node.title === 'Created');
  assert(created);
  assert(f.nodes.some(node => node.id === created.id && node.parentId === 'nested'));
  state = await f.api.handle({ type: 'BOOKMARKS_UPDATE', id: created.id, title: 'Renamed', url: 'https://renamed.test' });
  assert(state.nodes.some(node => node.title === 'Renamed' && node.url === 'https://renamed.test/'));
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_REMOVE', id: 'nested' }), /bookmarkNotEmpty/);
  await f.api.handle({ type: 'BOOKMARKS_MOVE', id: created.id, parentId: 'scope' });
  assert.equal(f.nodes.find(node => node.id === created.id).parentId, 'scope');
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_MOVE', id: 'scope', parentId: 'nested' }), /bookmarkInvalidMove|bookmarkProtected/);
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_REMOVE', id: 'scope' }), /bookmarkProtected/);
  await f.api.handle({ type: 'BOOKMARKS_REMOVE', id: created.id });
  assert(!f.nodes.some(node => node.id === created.id), 'LaterOn deletion removes the native bookmark');
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_CREATE', parentId: 'scope', title: 'Unsafe', url: 'javascript:alert(1)' }), /bookmarkInvalidUrl/);
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_UPDATE', id: 'inside', url: 'data:text/html,bad' }), /bookmarkInvalidUrl/);
  const outsideBefore = clone(f.nodes.find(node => node.id === 'outside'));
  await f.chrome.bookmarks.create({ parentId: 'nested', title: 'Browser-added', url: 'https://browser.test' });
  await f.api.refresh();
  assert(f.store.laterOnBookmarkState.nodes.some(node => node.title === 'Browser-added'), 'Browser changes refresh the dedicated mirror');
  const browserNode = f.nodes.find(node => node.title === 'Browser-added');
  await f.chrome.bookmarks.remove(browserNode.id);
  await f.api.refresh();
  assert(!f.store.laterOnBookmarkState.nodes.some(node => node.id === browserNode.id));
  await f.api.handle({ type: 'BOOKMARKS_COPY_ITEMS', ids: ['reading'], parentId: 'scope' });
  await f.api.handle({ type: 'BOOKMARKS_COPY_ITEMS', ids: ['reading'], parentId: 'scope' });
  assert.equal(f.nodes.filter(node => node.parentId === 'scope' && node.url === 'https://example.com/paper').length, 1, 'Copy avoids duplicate URL in the target folder');
  assert.deepEqual(f.store.laterOnItems, beforeReading, 'Native bookmarking never changes temporary reading data');
  assert.deepEqual(f.nodes.find(node => node.id === 'outside'), outsideBefore);
  state = await f.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: null });
  for (const id of ['0', '1', 'managed', 'policy']) await assert.rejects(f.api.handle({ type: 'BOOKMARKS_REMOVE', id }), /bookmarkProtected/);
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_CREATE', parentId: 'managed', title: 'No' }), /bookmarkProtected/);
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_REMOVE', id: 'scope' }), /bookmarkNotEmpty/);
  const beforeError = clone(f.store.laterOnBookmarkState.nodes);
  f.fail();
  await assert.rejects(f.api.refresh(), /Fixture failure/);
  assert.deepEqual(f.store.laterOnBookmarkState.nodes, beforeError, 'Read errors preserve the last good view');
  await f.api.refresh();
  assert(!f.store.laterOnBookmarkState.error);
  await f.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: 'nested' });
  f.nodes.splice(f.nodes.findIndex(node => node.id === 'nested'), 1);
  state = await f.api.refresh();
  assert.equal(state.error, 'bookmarkScopeMissing');
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_CREATE', parentId: '2', title: 'No', url: 'https://no.test' }), /bookmarkScopeMissing/);
  assert.equal(f.store.laterOnBookmarkConfig.scopeId, 'nested', 'Missing scope never broadens to all bookmarks');
  state = await f.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: false });
  assert.equal(state.enabled, false);
  assert.equal(f.nodes.length > 0, true, 'Disabling preserves native bookmarks');
  f.revoke();
  state = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(state.enabled, false);
  await assert.rejects(f.api.handle({ type: 'BOOKMARKS_REMOVE', id: 'outside' }), /bookmarkDisabled/);

  const g = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null } });
  g.grant();
  await g.api.refresh();
  for (const node of g.nodes) delete node.folderType;
  await assert.rejects(g.api.handle({ type: 'BOOKMARKS_REMOVE', id: '1' }), /bookmarkProtected/, 'Chrome 121 roots are protected without folderType');
  await g.api.handle({ type: 'BOOKMARKS_CREATE', parentId: '1', title: 'Child allowed', url: 'https://bar.test' });
  const request = g.chrome.runtime.onMessage.listeners[0];
  let denied;
  request({ type: 'BOOKMARKS_REMOVE', id: 'outside' }, { url: 'https://page.test/' }, response => { denied = response; });
  assert.equal(denied.ok, false, 'Injected webpage contexts cannot issue bookmark mutations');

  g.store.laterOnItems = [
    { id: 'good', title: 'Good', url: 'https://good.test/' },
    { id: 'bad', title: 'Bad', url: 'https://bad.test/' }
  ];
  const create = g.chrome.bookmarks.create;
  g.chrome.bookmarks.create = async data => { if (data.url === 'https://bad.test/') throw new Error('Fixture create failure'); return create(data); };
  state = await g.api.handle({ type: 'BOOKMARKS_COPY_ITEMS', parentId: '2', ids: ['good', 'bad', 'missing'] });
  assert.equal(state.results.added, 1);
  assert.equal(state.results.failed.length, 2);
  assert.deepEqual(Array.from(state.results.successfulIds), ['good']);
  g.chrome.bookmarks.create = create;
  state = await g.api.handle({ type: 'BOOKMARKS_COPY_ITEMS', parentId: '2', ids: ['good', 'bad'] });
  assert.equal(state.results.added, 1);
  assert.equal(state.results.existing, 1, 'Retry does not duplicate the successful subset');

  const set = g.chrome.storage.local.set;
  let failCache = false;
  g.chrome.storage.local.set = async patch => { if (failCache && patch.laterOnBookmarkState) { failCache = false; throw new Error('Cache write failed'); } return set(patch); };
  g.chrome.bookmarks.create = async data => { const node = await create(data); failCache = true; return node; };
  state = await g.api.handle({ type: 'BOOKMARKS_CREATE', parentId: '2', title: 'Committed', url: 'https://committed.test/' });
  assert.equal(state.committed, true, 'Cache failure after native success is not presented as an uncommitted operation');
  assert.equal(state.error, 'bookmarkRefreshFailed');
  assert.equal(g.nodes.filter(node => node.url === 'https://committed.test/').length, 1);
  await g.api.refresh();
  assert(!g.store.laterOnBookmarkState.error);
  g.revoke();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(g.store.laterOnBookmarkState.error, 'bookmarkPermission');
  await assert.rejects(g.api.handle({ type: 'BOOKMARKS_REMOVE', id: 'outside' }), /bookmarkPermission/);

  const restarted = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' } });
  assert(restarted.chrome.bookmarks.onCreated.listeners.length, 'Wake-up listeners exist synchronously before permission checks settle');
  restarted.grant();
  await restarted.api.refresh();
  await restarted.chrome.bookmarks.create({ parentId: 'scope', title: 'External event', url: 'https://external.test/' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(restarted.store.laterOnBookmarkState.nodes.some(node => node.title === 'External event'), 'Native events refresh the view without manual reads');
  restarted.store.laterOnItems = [{ id: 'a', title: 'A', url: 'https://a.test/' }, { id: 'b', title: 'B', url: 'https://b.test/' }];
  const nativeCreate = restarted.chrome.bookmarks.create;
  let copied = 0;
  restarted.chrome.bookmarks.create = async data => {
    const node = await nativeCreate(data);
    if (++copied === 1) await restarted.chrome.bookmarks.move('nested', { parentId: '2' });
    return node;
  };
  state = await restarted.api.handle({ type: 'BOOKMARKS_COPY_ITEMS', parentId: 'nested', ids: ['a', 'b'] });
  assert.equal(state.results.added, 1, 'A native destination move mid-batch must stop subsequent out-of-scope writes');
  assert.equal(state.results.failed.length, 1);
  assert.equal(state.results.failed[0].error, 'bookmarkOutOfScope');
  assert(!restarted.nodes.some(node => node.url === 'https://b.test/'));
  const optional = fixture({}, true);
  assert.equal((await optional.api.handle({ type: 'BOOKMARKS_GET' })).enabled, false);
  optional.chrome.bookmarks = optional.native;
  optional.grant();
  await optional.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: true });
  assert(optional.native.onCreated.listeners.length, 'Granting an initially unavailable API attaches native wake-up listeners');
  const guarded = fixture({}, false, true);
  assert.equal(guarded.native.onCreated.listeners.length, 0, 'Unavailable optional listeners do not break worker initialization');
  guarded.grant();
  await guarded.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: true });
  assert.equal(guarded.native.onCreated.listeners.length, 1);
  guarded.revoke();
  guarded.grant();
  await guarded.api.refresh();
  assert.equal(guarded.native.onCreated.listeners.length, 1, 'Regranting permission restores exactly one native listener');
  console.log('PASS bookmarks: native two-way operations, scope, permissions, protected nodes, deduplication, isolation, events, failure recovery and missing-scope safety');
}
module.exports = fixture;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });

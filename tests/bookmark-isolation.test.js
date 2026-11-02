const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const fixture = require('./bookmark-sync.test');
const ROOT = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const event = () => ({ addListener() {} });
(async () => {
  const f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null }, laterOnSettings: { autoCleanDays: 0 }, laterOnCleanupV165: true });
  f.grant();
  await f.api.refresh();
  const nativeBefore = copy(f.nodes), configBefore = copy(f.store.laterOnBookmarkConfig);
  Object.assign(f.chrome, {
    contextMenus: { removeAll(cb) { cb?.(); }, create() {}, onClicked: event() },
    commands: { onCommand: event(), async getAll() { return []; } },
    tabs: { onUpdated: event(), onRemoved: event(), onCreated: event() },
    action: {}, sidePanel: { setPanelBehavior() {} }
  });
  f.ctx.importScripts = () => {};
  f.ctx.clearTimeout = clearTimeout;
  vm.runInContext(read('url-utils.js'), f.ctx);
  vm.runInContext(read('background.js'), f.ctx);
  await f.ctx.purgeExpiredItems();
  assert.equal(f.store.laterOnItems.length, 0, 'Immediate reading cleanup removes its temporary copy');
  assert.deepEqual(f.nodes, nativeBefore, 'Reading cleanup never touches native bookmarks');
  await f.ctx.mutateItems({ operation: 'delete', ids: ['inside', 'reading'] });
  assert.deepEqual(f.nodes, nativeBefore, 'Reading item deletion cannot delete even a same-ID native bookmark');
  assert.deepEqual(f.store.laterOnBookmarkConfig, configBefore);

  f.store.laterOnItems = [{ id: 'reading', title: 'Reading original', url: 'https://example.com/paper' }];
  await f.api.handle({ type: 'BOOKMARKS_REMOVE', id: 'inside' });
  await f.api.refresh();
  assert.equal(f.store.laterOnItems.length, 1, 'Deleting the browser bookmark preserves the reading original');
  const afterBookmarkDeletion = copy(f.nodes);
  const stateBeforeWipe = copy(f.store.laterOnBookmarkState);
  const dom = new JSDOM(read('settings.html'), { runScripts: 'outside-only', url: 'chrome-extension://fixture/settings.html' });
  try {
    const { window } = dom;
    window.chrome = f.chrome;
    window.LaterOnDialog = { async confirm() { return true; }, async alert() {} };
    window.eval(read('theme.js'));
    window.eval(read('settings.js'));
    await new Promise(resolve => setTimeout(resolve, 10));
    window.document.querySelector('#wipeBtn').click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.store.laterOnItems.length, 0);
    assert.deepEqual(f.nodes, afterBookmarkDeletion, 'The actual settings-page reading wipe does not touch native bookmarks');
    assert.deepEqual(f.store.laterOnBookmarkConfig, configBefore);
    assert.deepEqual(f.store.laterOnBookmarkState, stateBeforeWipe, 'Reading wipe retains the bookmark area and its scope');
  } finally { dom.window.close(); }
  const ctx = vm.createContext({});
  vm.runInContext(read('webdav-sync-core.js'), ctx);
  const keys = ctx.LaterOnSyncCore?.KEYS || ctx.LaterOnWebDAVCore?.KEYS;
  assert(keys, 'Test uses the shipped sync-key contract');
  assert(!Array.from(keys).some(key => /bookmark/i.test(key)), 'Native bookmark IDs and cache never enter WebDAV');
  assert(!/laterOnBookmark/.test(read('settings.js')), 'Reading JSON import/export/wipe does not write bookmark keys');
  console.log('PASS bookmark isolation: real reading cleanup, mutation, settings wipe, native deletion, backup and WebDAV boundaries');
})().catch(error => { console.error(error); process.exitCode = 1; });

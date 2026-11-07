// Bounded bookmark views: the page mounts from the device-local IndexedDB
// snapshot without copying the native mirror, and every input is a bounded query.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => { for (let i = 0; i < 400 && !check(); i++) await tick(); assert(check(), message); };
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });

// As in the native mirror, the invisible tree root is not a listed folder.
const folders = [{ id: '1', parentId: '0', title: '书签栏', path: '书签栏', protected: true, writable: false, folderType: 'bookmarks-bar' },
  { id: 'research', parentId: '1', title: 'Research', path: '书签栏 / Research', protected: false, writable: true },
  { id: 'deep', parentId: 'research', title: '文献方法', path: '书签栏 / Research / 文献方法', protected: false, writable: true }];
const parents = ['1', 'research', 'deep'];
const pages = Array.from({ length: 900 }, (_, i) => ({ id: `b${i}`, parentId: parents[i % 3], dateAdded: 1000 + i,
  title: i % 5 === 0 ? `机器学习 ${i}` : `Page ${i}`, url: `https://site${i % 40}.test/p/${i}`, protected: false, writable: false,
  ...(i === 5 ? { preview: { url: 'https://site5.test/p/5', image: 'data:image/png;base64,iVBORw0KGgo=', description: 'cover' } } : {}) }));
const state = { enabled: true, scopeId: null, error: null, updatedAt: 5000, folders, nodes: [...folders, ...pages] };

(async () => {
  const indexedDB = new IDBFactory();
  const store = { laterOnBookmarkConfig: { enabled: true, scopeId: null }, laterOnSettings: { language: 'en' } };
  const changed = event(), messages = event(), calls = [], permissionAdded = event(), permissionRemoved = event();
  let granted = true;
  const dom = new JSDOM(read('bookmarks.html'), { runScripts: 'outside-only', url: 'chrome-extension://fixture/bookmarks.html?surface=sidepanel' });
  const { window } = dom;
  try {
    Object.assign(window, { indexedDB, IDBKeyRange });
    window.chrome = {
      storage: { local: { async get(keys) { return JSON.parse(JSON.stringify(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]])))); },
        async set(values) { Object.assign(store, values); } }, onChanged: changed },
      permissions: { async contains() { return granted; }, onAdded: permissionAdded, onRemoved: permissionRemoved },
      tabs: { async query() { return [{ id: 1, windowId: 1, active: true, title: 'Old page', url: 'https://site0.test/p/0' }]; }, onActivated: event(), onUpdated: event() },
      runtime: { onMessage: messages, getURL: name => `chrome-extension://fixture/${name}`, async sendMessage(message) {
        calls.push(message.type);
        if (message.type === 'BOOKMARKS_CHECK') return { ok: true, state: { updatedAt: 5000, changed: false } };
        if (message.type === 'BOOKMARKS_GET') return { ok: true, state };
        return { ok: true };
      } }
    };
    window.LaterOnDialog = { async confirm() { return false; }, async prompt() { return { ok: false }; } };
    window.eval(read('url-utils.js'));
    window.eval(read('quick-switcher-search.js'));
    window.eval(read('local-index.js'));
    await window.LaterOnLocalIndex.putBookmarkState(state);
    const started = Date.now();
    for (const file of ['bookmark-sidepanel.js', 'i18n.js', 'bookmark-view.js', 'bookmarks.js']) window.eval(read(file));
    const $ = selector => window.document.querySelector(selector);
    assert.equal($('#bookmarkEnable').hidden, true, 'Before any state arrives, sync is not presented as disabled');
    assert.equal($('#bookmarkSyncSettings').open, false, 'Loading does not force the settings open');
    assert.equal($('#bookmarkEmpty').hidden, true);
    await until(() => $('#bookmarkList').children.length > 0, 'The bounded snapshot mounts cards');
    const firstBody = Date.now() - started;
    assert.equal($('#bookmarkList').children.length, 12, 'The side panel first screen is a dozen rows');
    assert.equal($('#bookmarkList .bookmark-card').dataset.id, 'b899', 'Newest bookmarks lead the home view');
    assert.match($('#bookmarkCount').textContent, /900/, 'Counts describe the whole collection, not the loaded page');
    assert.equal($('#bookmarkMorePages').hidden, false);
    await until(() => calls.includes('BOOKMARKS_CHECK'), 'A small freshness probe is sent');
    assert(!calls.includes('BOOKMARKS_GET'), 'Startup with a snapshot never copies the full native mirror');
    await until(() => $('#bookmarkSaveCurrent .save-label').textContent === 'Bookmarked', 'A bookmark far outside the loaded page is still recognized');
    assert.equal($('#bookmarkSaveCurrent').disabled, true);
    assert.equal($('#bookmarkFolders').children.length, 0, 'The collapsed folder navigator is not built');

    $('#bookmarkMorePages').click();
    await until(() => $('#bookmarkList').children.length === 36, 'More loads the next bounded slice');

    const search = $('#bookmarkSearch');
    search.value = 'p'; search.dispatchEvent(new window.Event('input'));
    search.value = '机器学习'; search.dispatchEvent(new window.Event('input'));
    await until(() => /180/.test($('#bookmarkCount').textContent) && $('#bookmarkList').children.length === 12, 'Only the latest query result is shown');
    assert([...$('#bookmarkList').querySelectorAll('h2')].every(el => el.textContent.startsWith('机器学习')));
    search.value = '文献方法'; search.dispatchEvent(new window.Event('input'));
    await until(() => /300/.test($('#bookmarkCount').textContent), 'Folder ancestry remains searchable');
    search.value = ''; search.dispatchEvent(new window.Event('input'));
    await until(() => /900/.test($('#bookmarkCount').textContent));

    $('#bookmarkToggleFolders').click();
    await until(() => $('#bookmarkFolders li[data-folder-id="research"]'), 'Opening the navigator builds the tree');
    const research = $('#bookmarkFolders li[data-folder-id="research"] > .bookmark-tree-row');
    assert.equal(research.querySelector('.bookmark-folder-count').textContent, '600', 'Folder counts come from full summaries');
    research.querySelector('.bookmark-folder-nav').click();
    await until(() => $('#bookmarkViewTitle').textContent === 'Research' && /300/.test($('#bookmarkCount').textContent), 'Folders list direct pages with true totals');
    assert($('#bookmarkFolderCards .bookmark-folder-card[data-id="deep"]'));
    assert($('#bookmarkFolderCards img'), 'Folder covers resolve from summary preview references');
    assert([...$('#bookmarkList').children].every(card => Number(card.dataset.id.slice(1)) % 3 === 1));

    const before = calls.length;
    changed.emit({ laterOnBookmarkState: { newValue: state } }, 'local');
    await tick(20);
    assert.equal($('#bookmarkList').children.length, 12, 'A full state broadcast does not replace the bounded view');
    assert(calls.slice(before).every(type => type === 'BOOKMARKS_ACTIVITY'), 'A full mirror broadcast may refresh the bounded view, without requesting or transferring that mirror');
    // Revoking access leaves the indexed view at once; restoring it returns.
    granted = false;
    const getsBefore = calls.filter(type => type === 'BOOKMARKS_GET').length;
    permissionRemoved.emit({ permissions: ['bookmarks'] });
    assert.equal($('#bookmarkList').children.length, 0, 'Revocation removes indexed bookmark cards synchronously');
    assert.equal($('#bookmarkEnable').hidden, false, 'Revocation offers authorization again');
    await tick(20);
    permissionAdded.emit({ permissions: ['tabs'] });
    await tick(20);
    assert.equal($('#bookmarkList').children.length, 0, 'Unrelated permission changes do not restore bookmark data');
    granted = true;
    permissionAdded.emit({ permissions: ['bookmarks'] });
    await until(() => $('#bookmarkList').children.length === 12, 'Granting access again restores the bounded view');
    assert.equal(calls.filter(type => type === 'BOOKMARKS_GET').length, getsBefore, 'The bounded view returns without a full mirror request');
    console.log(`PASS bookmark paged view: cached first screen without full GET (first body ${firstBody}ms in jsdom+fake IndexedDB), true totals, latest-wins input, lazy tree, membership beyond the page, no full replacement and live permission changes`);
  } finally { window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

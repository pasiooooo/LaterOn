const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function observed(signal, message) {
  let timer;
  try {
    await Promise.race([signal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 10000); })]);
  } finally { clearTimeout(timer); }
}
const connected = () => ({ enabled: true, error: '', scopeId: null,
  folders: [{ id: 'folder', title: 'Research', path: 'Research', writable: true }],
  nodes: [{ id: 'folder', title: 'Research', writable: true },
    { id: 'article', parentId: 'folder', title: 'A real bookmark', url: 'https://article.test/one' }] });

function mount(language = 'en') {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(read('bookmarks.html'), { runScripts: 'outside-only',
    url: 'chrome-extension://fixture/bookmarks.html?surface=sidepanel', virtualConsole });
  const window = dom.window, requests = [], ready = [], listeners = [];
  let requestStarted, readySent;
  const firstRequest = new Promise(resolve => { requestStarted = resolve; });
  const firstReady = new Promise(resolve => { readySent = resolve; });
  window.LaterOnI18n = { async getLanguage() { return language; }, applyStatic() {} };
  window.LaterOnSidepanelSwitch = { isActive() { return true; }, ready() {
    ready.push({ status: window.document.querySelector('#bookmarkStatus').textContent,
      connection: window.document.querySelector('#bookmarkConnectionLabel').textContent,
      hasArticle: !!window.document.querySelector('.bookmark-card[data-id="article"]'),
      refreshDisabled: window.document.querySelector('#bookmarkRefresh').disabled });
    readySent();
  } };
  window.chrome = {
    storage: { local: { async get() { return {}; }, async set() {} },
      onChanged: { addListener(listener) { listeners.push(listener); } } },
    tabs: { async query() { return []; }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { getURL: name => `chrome-extension://fixture/${name}`, sendMessage(message) {
      if (message.type === 'BOOKMARKS_GET') return new Promise((resolve, reject) => { requests.push({ resolve, reject }); requestStarted(); });
      return Promise.resolve({ ok: true });
    } }
  };
  for (const script of ['url-utils.js', 'bookmark-sidepanel.js', 'bookmark-view.js', 'bookmarks.js']) window.eval(read(script));
  return { dom, window, requests, ready, firstRequest, firstReady, errors, change(state) {
    listeners.forEach(listener => listener({ laterOnBookmarkState: { newValue: state } }, 'local'));
  } };
}
async function started(fixture) {
  await observed(Promise.race([fixture.firstRequest, fixture.firstReady.then(() => {
    throw new Error('Bookmark startup signaled ready before issuing its initial GET');
  })]), 'The initial native bookmark request was never issued');
  assert.equal(fixture.requests.length, 1, 'The initial native bookmark request has started');
  // The startup render and synchronous loading UI have already run here.
  assert.equal(fixture.ready.length, 0, 'A placeholder/loading render cannot reveal the bookmark iframe');
  assert.equal(fixture.window.document.querySelector('#bookmarkRefresh').disabled, true);
}
async function settled(fixture) {
  await observed(fixture.firstReady, 'Bookmark startup did not signal ready after its initial GET settled');
  assert.equal(fixture.ready.length, 1, 'Initial completion emits one ready signal');
  assert.equal(fixture.ready[0].refreshDisabled, false, 'Ready is sent after the UI becomes interactive');
  assert.deepEqual(fixture.errors, []);
}

(async () => {
  for (const language of ['en', 'zh-CN']) {
    const loaded = mount(language);
    try {
      await started(loaded);
      // Both user-driven rendering and a background cache event can happen
      // before the initial GET settles. Neither is the initial-ready boundary.
      const search = loaded.window.document.querySelector('#bookmarkSearch');
      search.value = 'bookmark'; search.dispatchEvent(new loaded.window.Event('input'));
      loaded.change(connected()); await tick();
      assert.equal(loaded.ready.length, 0, 'Search/cache renders must not signal ready while initial GET is pending');
      loaded.requests[0].resolve({ ok: true, state: connected() });
      await settled(loaded);
      assert(loaded.window.document.querySelector('.bookmark-card[data-id="article"]'), 'Real bookmark cards are mounted before readiness');
      assert.equal(loaded.ready[0].hasArticle, true);
      assert.match(loaded.ready[0].connection, language === 'en' ? /Connected/ : /已连接/);
      search.value = ''; search.dispatchEvent(new loaded.window.Event('input')); loaded.change(connected()); await tick();
      assert.equal(loaded.ready.length, 1, 'Later list renders do not repeat the initial ready signal');
    } finally { loaded.window.close(); }
  }

  for (const failure of ['response', 'rejection']) {
    const failed = mount();
    try {
      await started(failed);
      if (failure === 'response') failed.requests[0].resolve({ ok: false, error: 'failed' });
      else failed.requests[0].reject(new Error('Background is unavailable'));
      await settled(failed);
      assert.match(failed.ready[0].status, /Refresh and try again\./, 'Failed startup reveals an actionable retry error');
      assert.equal(failed.window.document.querySelector('#bookmarkStatus').classList.contains('visually-hidden'), false);
      assert.equal(failed.window.document.querySelector('#bookmarkSyncSettings').open, true, 'Recovery controls are exposed on first-load failure');
      failed.window.document.querySelector('#bookmarkRefresh').click();
      assert.equal(failed.requests.length, 2, 'The revealed error view can issue a retry');
      failed.requests[1].resolve({ ok: true, state: connected() }); await tick(); await tick();
      assert(failed.window.document.querySelector('.bookmark-card[data-id="article"]'), 'Retry recovers the bookmark list');
      assert.match(failed.window.document.querySelector('#bookmarkConnectionLabel').textContent, /Connected/);
      assert.equal(failed.ready.length, 1, 'Retry renders do not trigger another startup handshake');
      assert.deepEqual(failed.errors, []);
    } finally { failed.window.close(); }
  }

  const disconnected = mount();
  try {
    await started(disconnected);
    disconnected.requests[0].resolve({ ok: true, state: { enabled: false, scopeId: null, nodes: [], folders: [] } });
    await settled(disconnected);
    assert.match(disconnected.ready[0].status, /Not enabled/);
    assert.equal(disconnected.window.document.querySelector('#bookmarkEnable').hidden, false);
    assert.equal(disconnected.window.document.querySelector('#bookmarkEnable').disabled, false, 'An unconnected library is ready for user authorization');
    assert.equal(disconnected.window.document.querySelector('#bookmarkSyncSettings').open, true);
  } finally { disconnected.window.close(); }
  console.log('PASS bookmark initial readiness: delayed GET blocks placeholder/cache/search ready; success emits once after cards, failures reveal retry, disconnected setup is ready');
})().catch(error => { console.error(error); process.exitCode = 1; });

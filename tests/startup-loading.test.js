const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const pageItem = id => ({ id, title: id, url: `https://example.test/${id}`, description: '',
  image: '', favicon: '', source: 'example.test', status: 'unread', savedAt: Date.now(), projectId: null });
const data = () => ({ laterOnItems: [pageItem('saved')], laterOnProjects: [],
  laterOnActiveProject: 'unfiled', laterOnSettings: {}, laterOnCovers: {} });

function fixture(file, get) {
  const errors = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(read(file), { url: `chrome-extension://fixture/${file}`,
    pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: console });
  const window = dom.window, listeners = new Set(), gets = [];
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map();
    Object.defineProperty(window, name, { configurable: true, value: {
      getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key)
    } });
  }
  window.scrollTo = () => {};
  window.chrome = {
    storage: { local: { get(keys) { gets.push(keys); return get(keys); }, async set() {} },
      onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } } },
    tabs: { async query() { return []; }, async getCurrent() { return { id: 11, windowId: 7 }; },
      onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    windows: { async getCurrent() { return { id: 7 }; } },
    runtime: { getURL: name => `chrome-extension://fixture/${name}`, onMessage: { addListener() {} },
      async sendMessage() { return { ok: false }; } }
  };
  return { dom, window, errors, gets, listeners, change(key, value, area = 'local') {
    for (const fn of [...listeners]) fn({ [key]: { newValue: value } }, area);
  } };
}

(async () => {
  const initial = data();
  const early = fixture('sidepanel.html', async () => initial);
  try {
    early.window.eval(read('boot.js'));
    assert.equal(early.gets.length, 1, 'Boot starts one collection read and reuses its settings for the loading tip');
    assert(early.gets[0].includes('laterOnItems'));
    assert(!early.gets[0].includes('laterOnCovers'), 'Large cover blobs stay out of the startup request');
    await tick();
    early.change('laterOnItems', [pageItem('new')]);
    early.change('laterOnActiveProject', 'research');
    early.change('laterOnFilter', undefined);
    early.change('laterOnItems', [pageItem('wrong-area')], 'sync');
    const merged = await early.window.LaterOnBoot.readingData.take();
    assert.deepEqual(Array.from(merged.laterOnItems, item => item.id), ['new'],
      'Changes after the early read settles are retained until the page consumes it');
    assert.equal(merged.laterOnActiveProject, 'research');
    assert.equal(merged.laterOnFilter, undefined, 'Removal of a stored preference is retained');
    assert.equal(early.listeners.size, 0, 'The temporary change listener is removed after consumption');
    assert.equal(initial.laterOnItems[0].id, 'saved', 'The original storage snapshot is not mutated');
    early.window.LaterOnBoot.done();
    assert.deepEqual(early.errors, []);
  } finally { early.dom.window.close(); }

  const failed = fixture('sidepanel.html', () => Promise.reject(Error('storage unavailable')));
  try {
    failed.window.eval(read('boot.js'));
    const result = await failed.window.LaterOnBoot.readingData.take();
    assert.match(result.__laterOnLoadError, /storage unavailable/);
    assert.equal(failed.listeners.size, 0);
    failed.window.LaterOnBoot.done();
    assert.deepEqual(failed.errors, [], 'A failed prefetch remains a recoverable load error');
  } finally { failed.dom.window.close(); }

  const store = data();
  const panel = fixture('sidepanel.html', async keys => {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter(key => key in store).map(key => [key, store[key]]));
  });
  try {
    panel.window.eval(read('boot.js'));
    await tick();
    panel.window.eval(read('url-utils.js'));
    panel.window.eval(read('sidepanel.js'));
    await tick(); await tick();
    assert(panel.window.document.querySelector('#items .item[data-id="saved"]'));
    assert.equal(panel.gets.filter(keys => Array.isArray(keys) && keys.includes('laterOnItems')).length, 1,
      'The side panel consumes the early request instead of reading the collection twice');
    assert.deepEqual(panel.errors, []);
  } finally { panel.dom.window.close(); }

  let releaseLanguage, language = 'zh-CN', repeated = 0;
  const languageReady = new Promise(resolve => { releaseLanguage = resolve; });
  const libraryStore = { ...store, laterOnProjects: [{ id: 'research', name: 'Research' }] };
  const library = fixture('library.html', async keys => {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter(key => key in libraryStore).map(key => [key, libraryStore[key]]));
  });
  try {
    library.window.LaterOnI18n = { ready: languageReady,
      getLanguage() { repeated++; return languageReady; }, applyStatic() {}, t: key => `${language}:${key}` };
    library.window.eval(read('library.js'));
    await tick(); await tick();
    assert(library.window.document.querySelector('#boardGrid .board-card'),
      'The complete library renders while the authoritative language request is pending');
    assert(library.gets.some(keys => Array.isArray(keys) && keys.includes('laterOnItems')));
    assert.equal(repeated, 0, 'The library reuses i18n.ready instead of starting a second language read');
    const search = library.window.document.querySelector('#searchInput');
    search.value = 'draft input';
    language = 'en'; releaseLanguage(language); await tick(); await tick();
    assert.match(library.window.document.querySelector('#countText').textContent, /^en:/);
    assert.equal(search.value, 'draft input', 'Language calibration retains the input');
    assert.deepEqual(library.errors, []);
  } finally { library.dom.window.close(); }

  for (const [page, core] of [['sidepanel.html', 'sidepanel.js'], ['library.html', 'library.js'], ['bookmarks.html', 'bookmarks.js']]) {
    const html = read(page);
    assert(html.indexOf(`src="${core}"`) < html.indexOf('src="quick-switcher-ui.js"'),
      `${page} starts its core view before loading the optional switcher`);
  }
  console.log('PASS early startup data, buffered changes/removals, failure recovery, one collection read, language-independent library rendering and script order');
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const source = read('sidepanel-switch.js');
const urls = { reading: 'sidepanel.html', bookmarks: 'bookmarks.html?surface=sidepanel' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function markup(home) {
  return `<nav class="library-switch"><a href="${urls.reading}"${home === 'reading' ? ' aria-current="page"' : ''}>Reading</a><a href="${urls.bookmarks}"${home === 'bookmarks' ? ' aria-current="page"' : ''}>Bookmarks</a></nav><a class="brand" href="sidepanel.html">LaterOn</a><input id="search"><article id="retained-card">A retained card</article><p id="status"></p>`;
}
function scrolling(window) {
  let position = 0;
  const calls = [];
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => position });
  window.scrollTo = options => { calls.push(options); position = Number(options.top) || 0; };
  return { calls, set(value) { position = value; } };
}
function fixture(home) {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(markup(home), { runScripts: 'outside-only', url: `chrome-extension://fixture/${urls[home]}`, virtualConsole });
  const window = dom.window, document = window.document, alternate = home === 'reading' ? 'bookmarks' : 'reading';
  const scroll = scrolling(window), timers = new Map(); let timerId = 0;
  window.setTimeout = (run, ms) => { const id = ++timerId; timers.set(id, { run, ms }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.LaterOnI18n = { t: key => key === 'loadFailedRetry' ? 'Retry the library' : key };
  window.eval(source);
  const api = window.LaterOnSidepanelSwitch;
  function click(view, target, options = {}) {
    const link = view.document.querySelector(`.library-switch a[href="${urls[target]}"]`);
    const event = new view.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options });
    link.dispatchEvent(event); return event;
  }
  function mount(ready = true) {
    const frame = document.querySelector('#laterOnAlternatePanel'), view = frame.contentWindow;
    view.document.open(); view.document.write(markup(alternate)); view.document.close();
    const viewScroll = scrolling(view); view.eval(source);
    if (ready) view.LaterOnSidepanelSwitch.ready();
    return { frame, view, scroll: viewScroll };
  }
  return { dom, window, document, home, alternate, scroll, timers, api, click, mount, errors };
}

async function lifecycle(home) {
  const f = fixture(home), { window, document, api } = f;
  try {
    const rootDocument = document, originalLocation = window.location.href;
    const rootSearch = document.querySelector('#search'), rootCard = document.querySelector('#retained-card');
    rootSearch.value = 'retained reading search'; f.scroll.set(360);
    assert.equal(api.isActive(), true);
    const click = f.click(window, f.alternate);
    assert.equal(click.defaultPrevented, true, 'A normal library click is handled in the same side panel');
    const frame = document.querySelector('iframe');
    assert(frame && frame.inert, 'The alternate stays inert until its list is ready');
    assert.equal(document.documentElement.classList.contains('sidepanel-alternate-active'), false, 'Loading retains the visible current surface');
    assert.equal(document.querySelector('.library-switch').getAttribute('aria-busy'), 'true');
    for (let i = 0; i < 3; i++) f.click(window, f.alternate);
    assert.equal(document.querySelectorAll('iframe').length, 1, 'Rapid repeated switches share a single loading document');
    assert.equal(f.timers.size, 1, 'Repeated loading clicks retain one timeout');
    const child = f.mount(false), childApi = child.view.LaterOnSidepanelSwitch;
    assert.equal(childApi.isActive(), false);
    assert.equal(api.owns(child.view), true);
    assert.equal(api.owns({}), false);
    const childSearch = child.view.document.querySelector('#search'), childCard = child.view.document.querySelector('#retained-card');
    childSearch.value = 'retained bookmark search'; child.scroll.set(215);
    let rootVisible = 0, childVisible = 0;
    window.addEventListener('lateron-sidepanel-visible', () => rootVisible++);
    child.view.addEventListener('lateron-sidepanel-visible', () => childVisible++);
    childApi.ready();
    assert.equal(frame.classList.contains('is-active'), true);
    assert.equal(frame.inert, false);
    assert.equal(api.isActive(), false);
    assert.equal(childApi.isActive(), true);
    assert.equal(child.view.document.activeElement, child.view.document.querySelector('[aria-current="page"]'), 'The revealed library receives visible keyboard focus');
    assert.equal(childVisible, 1);
    assert.equal(f.timers.size, 0);
    for (let i = 0; i < 5; i++) {
      assert.equal(f.click(child.view, home).defaultPrevented, true, 'Iframe clicks delegate to their owning root');
      assert.equal(api.isActive(), true);
      assert.equal(frame.inert, true);
      assert.equal(window.scrollY, 360, 'The home document recovers its own scroll position');
      assert.equal(document.activeElement, document.querySelector('[aria-current="page"]'));
      f.click(window, f.alternate);
      assert.equal(childApi.isActive(), true);
    }
    assert.equal(document, rootDocument);
    assert.equal(window.location.href, originalLocation, 'Ordinary switching never navigates/reloads the root document');
    assert.equal(document.querySelector('iframe'), frame);
    assert.equal(frame.contentWindow, child.view);
    assert.equal(document.querySelector('#retained-card'), rootCard);
    assert.equal(child.view.document.querySelector('#retained-card'), childCard);
    assert.equal(document.querySelector('#search'), rootSearch);
    assert.equal(rootSearch.value, 'retained reading search');
    assert.equal(childSearch.value, 'retained bookmark search');
    assert.equal(child.view.scrollY, 215, 'Switching does not reset alternate document scrolling');
    assert.equal(rootVisible, 5); assert.equal(childVisible, 6);
    assert.deepEqual(f.errors, []);
  } finally { window.close(); }
}

(async () => {
  await lifecycle('reading');
  await lifecycle('bookmarks');
  const cancelled = fixture('reading');
  try {
    cancelled.click(cancelled.window, 'bookmarks');
    const child = cancelled.mount(false);
    cancelled.click(cancelled.window, 'reading');
    child.view.LaterOnSidepanelSwitch.ready();
    assert.equal(cancelled.api.isActive(), true, 'A late ready signal cannot undo a newer switch back home');
    assert.equal(child.frame.classList.contains('is-active'), false);
    cancelled.click(cancelled.window, 'bookmarks');
    assert.equal(child.frame.classList.contains('is-active'), true, 'The now-ready document is reusable');
    cancelled.api.navigate('bookmarks.html?surface=sidepanel&folder=research');
    const replacement = cancelled.document.querySelector('iframe');
    assert.notEqual(replacement, child.frame, 'Explicit folder operations receive their requested document');
    assert.equal(cancelled.api.isActive(), true, 'Replacing an active alternate keeps the home view visible while loading');
    cancelled.api.ready(child.view);
    assert.equal(replacement.classList.contains('is-active'), false, 'A removed iframe cannot mark its replacement ready');
    cancelled.mount();
    assert.equal(replacement.classList.contains('is-active'), true, 'An explicit operation replacing the active iframe still becomes visible');
  } finally { cancelled.window.close(); }

  const failed = fixture('reading');
  try {
    failed.click(failed.window, 'bookmarks');
    const timeout = [...failed.timers.values()][0];
    assert.equal(timeout.ms, 12000);
    timeout.run();
    assert.equal(failed.document.querySelector('iframe'), null);
    assert.equal(failed.api.isActive(), true);
    assert.equal(failed.document.querySelector('#status').textContent, 'Retry the library');
    assert.equal(failed.document.querySelector('.library-switch').hasAttribute('aria-busy'), false);
    failed.click(failed.window, 'bookmarks'); failed.mount();
    assert.equal(failed.api.isActive(), false, 'An expired load remains retryable');
    for (const target of ['https://example.com/sidepanel.html', 'chrome-extension://other/sidepanel.html', 'bookmarks.html', 'settings.html']) {
      assert.equal(failed.api.navigate(target), false, 'Only sibling side-panel surfaces are intercepted');
    }
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      assert.equal(failed.click(failed.window, 'reading', { [modifier]: true }).defaultPrevented, false, 'Modified links retain native browser behavior');
    }
  } finally { failed.window.close(); }

  // Exercise the real reading render/readiness and visibility hooks with native
  // APIs mocked; a pending current-item locate must wait until reading is shown.
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error.message));
  const reading = new JSDOM(read('sidepanel.html'), { runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'chrome-extension://fixture/sidepanel.html', virtualConsole });
  try {
    const w = reading.window, store = { laterOnItems: Array.from({ length: 7 }, (_, index) => ({ id: `item-${index}`, title: `Article ${index}`,
      url: `https://article.test/${index}`, source: 'article.test', savedAt: 100 - index, status: 'unread', projectId: null })),
      laterOnProjects: [], laterOnActiveProject: 'all', laterOnCurrentItem: null, laterOnSettings: {}, laterOnCovers: {} };
    const listeners = [], messages = [], scroll = scrolling(w), local = new Map();
    Object.defineProperty(w, 'localStorage', { configurable: true, value: { getItem: key => local.get(key) || null,
      setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) } });
    Object.defineProperty(w, 'innerHeight', { value: 600 });
    Object.defineProperty(w.document.documentElement, 'scrollHeight', { value: 1600 });
    w.Element.prototype.getBoundingClientRect = function () {
      if (this.matches('header')) return { top: 0, bottom: 58, height: 58 };
      const index = Number(this.dataset.id?.replace('item-', ''));
      const top = (Number.isFinite(index) ? 200 + index * 120 : 0) - w.scrollY;
      return { top, bottom: top + 92, height: 92 };
    };
    w.chrome = { storage: { local: { async get() { return store; }, async set(patch) { Object.assign(store, patch); } },
      onChanged: { addListener(fn) { listeners.push(fn); } } }, tabs: { async query() { return []; },
      onActivated: { addListener() {} }, onUpdated: { addListener() {} } }, windows: { async getCurrent() { return { id: 4 }; } },
      runtime: { getURL: name => `chrome-extension://fixture/${name}`, async sendMessage() { return { ok: false }; }, onMessage: { addListener(fn) { messages.push(fn); } } } };
    for (const script of ['url-utils.js', 'sidepanel-switch.js', 'sidepanel.js']) w.eval(read(script));
    await wait(140);
    assert.equal(w.document.querySelectorAll('#items .item').length, 7);
    assert.equal(w.document.body.classList.contains('booting'), false);
    w.LaterOnSidepanelSwitch.navigate(urls.bookmarks);
    const frame = w.document.querySelector('iframe');
    frame.contentDocument.open(); frame.contentDocument.write(markup('bookmarks')); frame.contentDocument.close();
    frame.contentWindow.eval(source); frame.contentWindow.LaterOnSidepanelSwitch.ready();
    for (const listener of listeners) listener({ laterOnCurrentItem: { newValue: 'item-6' } }, 'local');
    await wait(40);
    assert.equal(scroll.calls.length, 0, 'Hidden reading updates must not move its scroll');
    w.LaterOnSidepanelSwitch.navigate(urls.reading); await wait(40);
    assert(scroll.calls.some(call => call.behavior === 'smooth' && call.top > 0), 'Showing reading resumes a current-item locate deferred while hidden');
    w.LaterOnSidepanelSwitch.navigate(urls.bookmarks);
    const result = await new Promise(resolve => {
      for (const listener of messages) listener({ type: 'PING_SIDEPANEL', windowId: 4 }, {}, resolve);
    });
    assert.equal(result.ready, true);
    assert.equal(w.LaterOnSidepanelSwitch.isActive(), true, 'The full-page handshake restores a mounted hidden reading surface');
    assert.deepEqual(errors, []);
  } finally { reading.window.close(); }

  // Transfers from either a root or embedded reading document use the owning
  // switcher; full-page transfers continue to create a full bookmark tab.
  for (const page of ['sidepanel.html', 'library.html']) {
    const dom = new JSDOM('', { runScripts: 'outside-only', url: `chrome-extension://fixture/${page}` });
    try {
      const navigated = [], tabs = [];
      dom.window.chrome = { runtime: { getURL: name => `chrome-extension://fixture/${name}` }, tabs: { async create(options) { tabs.push(options.url); } } };
      dom.window.LaterOnSidepanelSwitch = { navigate(url) { navigated.push(url); return true; } };
      dom.window.eval(read('bookmark-transfer.js'));
      await dom.window.LaterOnBookmarkTransfer.open(['one', 'one', 'two']);
      assert.equal(navigated.length, page === 'sidepanel.html' ? 1 : 0);
      assert.equal(tabs.length, page === 'library.html' ? 1 : 0);
      const target = new URL((navigated.length ? navigated : tabs)[0]);
      assert.equal(target.searchParams.get('items'), '["one","two"]');
      assert.equal(target.searchParams.get('surface'), page === 'sidepanel.html' ? 'sidepanel' : null);
    } finally { dom.window.close(); }
  }
  console.log('PASS persistent sidepanel switch: both root surfaces, readiness/races, DOM/search/scroll/focus retention, retries, explicit operations, reading locate/handshake and transfer routing');
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const fixture = require('./bookmark-sync.test');
const read = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter(value => value !== fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
(async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const url = 'https://current.test/article';
  const f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null }, laterOnItems: [{ id: 'reading', url, title: 'Saved reading title', status: 'done', description: 'Saved summary' }] });
  f.grant();
  let active = { id: 9, windowId: 4, active: true, status: 'complete', title: 'Tab title', url }, extractions = 0;
  const session = {}, errors = [], probes = [];
  f.chrome.tabs = { async query() { return [{ ...active }]; }, async get(id) { if (id !== active.id) throw Error('Closed'); return { ...active }; }, onUpdated: event(), onActivated: event(), onRemoved: event() };
  f.chrome.windows = { async getCurrent() { return { id: 4 }; } };
  f.chrome.storage.session = { async get(key) { return structuredClone({ [key]: session[key] }); }, async set(patch) { Object.assign(session, structuredClone(patch)); } };
  f.ctx.extractTabMetadataById = async () => { extractions++; return { ok: true, metadata: { url: active.url, title: 'Shared article', titleFrom: 'dom-headline',
    description: 'Shared summary', image: png, favicon: '', source: 'Publication', isSaved: true } }; };
  vm.runInContext(read('current-page-background.js'), f.ctx);
  const mount = async bookmark => {
    const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM(read(bookmark ? 'bookmarks.html' : 'sidepanel.html'), { runScripts: 'outside-only', pretendToBeVisual: true,
      url: `chrome-extension://fixture/${bookmark ? 'bookmarks.html?surface=sidepanel' : 'sidepanel.html'}`, virtualConsole: vc });
    const { window } = dom, cleanup = [];
    const scoped = api => ({ addListener(fn) { api.addListener(fn); cleanup.push(() => api.removeListener(fn)); } });
    window.chrome = { ...f.chrome,
      tabs: { ...f.chrome.tabs, onActivated: scoped(f.chrome.tabs.onActivated), onUpdated: scoped(f.chrome.tabs.onUpdated) },
      storage: { ...f.chrome.storage, onChanged: scoped(f.chrome.storage.onChanged) },
      runtime: { ...f.chrome.runtime, onMessage: scoped(f.chrome.runtime.onMessage), async sendMessage(message) {
        if (message.type === 'EXTRACT_METADATA') return f.ctx.LaterOnCurrentPageMetadata.get(message.tabId);
        if (message.type.startsWith('BOOKMARKS_')) return { ok: true, state: await f.api.handle(message) };
        return { ok: true };
      } }
    };
    window.scrollTo = () => {};
    window.Image = class extends window.EventTarget { set src(value) { this.value = value; probes.push(this); queueMicrotask(() => this.dispatchEvent(new window.Event('load'))); } };
    Object.defineProperty(window, 'localStorage', { value: { getItem() { return null; }, setItem() {}, removeItem() {} } });
    for (const file of bookmark ? ['bookmark-sidepanel.js', 'i18n.js', 'bookmark-view.js', 'bookmarks.js'] : ['i18n.js', 'url-utils.js', 'sidepanel.js']) window.eval(read(file));
    for (let i = 0; i < 20 && window.document.querySelector(bookmark ? '#bookmarkCurrentTitle' : '#currentTitle').textContent !== 'Shared article'; i++) await tick();
    if (!bookmark) for (let i = 0; i < 20 && window.document.body.classList.contains('booting'); i++) await tick();
    return { window, $: selector => window.document.querySelector(selector), close() { cleanup.forEach(fn => fn()); window.close(); } };
  };
  let panel = await mount(false);
  assert.equal(panel.$('#currentTitle').textContent, 'Shared article');
  assert.equal(panel.$('#saveCurrent').disabled, true, 'This URL is already in the reading library');
  assert.equal(extractions, 1); panel.close();
  panel = await mount(true);
  assert.equal(panel.$('#bookmarkCurrentTitle').textContent, 'Shared article', 'Switching to bookmarks reuses the extracted title');
  assert.equal(panel.$('#bookmarkCurrentSource').textContent, 'Publication');
  assert.equal(panel.$('#bookmarkCurrentThumb img.bookmark-current-cover').getAttribute('src'), png);
  assert.equal(panel.$('#bookmarkSaveCurrent').disabled, false, 'Reading membership must not disable bookmark addition');
  assert.equal(extractions, 1, 'A library switch does not extract the page again');
  const bookmark = await f.chrome.bookmarks.create({ parentId: 'scope', title: 'User bookmark title', url });
  await tick(); assert.equal(panel.$('#bookmarkSaveCurrent').disabled, true);
  assert.equal(panel.$('#bookmarkCurrentTitle').textContent, 'Shared article', 'A saved bookmark title does not overwrite shared page facts');
  assert.equal(extractions, 1);
  await f.chrome.storage.local.set({ laterOnItems: [] }); await tick(); panel.close();
  panel = await mount(false);
  assert.equal(panel.$('#saveCurrent').disabled, false, 'A bookmark does not imply membership in the reading library');
  assert.equal(panel.$('#currentTitle').textContent, 'Shared article'); assert.equal(extractions, 1); panel.close();
  panel = await mount(true);
  assert.equal(panel.$('#bookmarkSaveCurrent').disabled, true);
  await f.chrome.bookmarks.remove(bookmark.id); await tick();
  assert.equal(panel.$('#bookmarkSaveCurrent').disabled, false); assert.equal(extractions, 1);
  active = { ...active, id: 12, title: 'Next page', url: 'https://next.test/' };
  f.chrome.tabs.onActivated.emit({ tabId: 12, windowId: 4 }); await tick();
  assert.equal(extractions, 2); panel.close();
  panel = await mount(false); assert.equal(extractions, 2, 'Returning to reading shares the new tab snapshot too');
  const oldProbe = probes.at(-1);
  active = { ...active, id: 13, title: 'Unsupported', url: 'chrome://settings/' };
  f.chrome.tabs.onActivated.emit({ tabId: 13, windowId: 4 }); await tick();
  oldProbe.dispatchEvent(new panel.window.Event('load'));
  assert.equal(panel.$('#currentThumb').classList.contains('has-cover'), false, 'Late cover loads cannot paint an unrelated page');
  panel.close();
  assert.deepEqual(errors, []);
  console.log('PASS shared sidepanel current page: rich facts reused across real reading/bookmark controllers, independent membership, native titles, tab changes and late cover guards');
})().catch(error => { console.error(error); process.exitCode = 1; });

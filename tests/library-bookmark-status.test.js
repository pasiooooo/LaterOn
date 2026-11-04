const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const read = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
(async () => {
  const dom = new JSDOM(read('library.html'), { runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'chrome-extension://fixture/library.html?from=sidepanel&project=unfiled&filter=all' });
  const { window } = dom, document = window.document;
  const queryUrl = 'https://www.google.com/search?q=climate+model';
  const item = (id, extra) => ({ id, title: 'Search Results', description: 'Summary', image: '', favicon: '', source: 'Google', projectId: null,
    url: queryUrl, savedAt: Date.now(), status: 'unread', ...extra });
  const store = { laterOnItems: [item('auto'), item('edited', { title: 'My search notes', titleEdited: true, url: 'https://www.google.com/search?q=edited' })],
    laterOnProjects: [], laterOnSettings: {}, laterOnBookmarkConfig: { enabled: true, scopeId: null },
    laterOnBookmarkState: { enabled: true, scopeId: null, nodes: [{ id: 'native', url: queryUrl }] } };
  const before = JSON.stringify(store.laterOnItems), changed = event();
  let writes = 0;
  window.scrollTo = () => {};
  window.chrome = { storage: { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]])); },
    async set(patch) { writes++; Object.assign(store, patch); }
  }, onChanged: changed }, permissions: { async contains() { return true; }, onAdded: event(), onRemoved: event() },
    tabs: { async query() { return [{ id: 1, windowId: 2 }]; } }, runtime: { onMessage: event(), getURL: value => `chrome-extension://fixture/${value}` } };
  try {
    window.eval(read('url-utils.js'));
    window.eval(read('reading-bookmark-status.js'));
    window.eval(read('library.js'));
    await window.LaterOnReadingBookmarkStatus.ready; await tick();
    const card = document.querySelector('.card[data-id="auto"]');
    assert(card);
    const badge = card.querySelector('.source-name .reading-bookmark-status');
    assert(badge);
    assert.equal(badge.hidden, false);
    assert.equal(card.querySelector('h2').textContent, 'climate model - Google', 'Previously saved generic search titles display the actual query');
    assert.equal(document.querySelector('.card[data-id="edited"] h2').textContent, 'My search notes', 'Manual titles remain authoritative');
    assert.equal(document.querySelector('.card[data-id="edited"] .reading-bookmark-status').hidden, true);
    const select = card.querySelector('.project-select'); select.focus();
    changed.emit({ laterOnBookmarkState: { newValue: { enabled: true, scopeId: null, nodes: [] } } }, 'local');
    assert.equal(badge.hidden, true);
    assert.equal(document.querySelector('.card[data-id="auto"]'), card, 'Bookmark changes retain the reading card DOM');
    assert.equal(document.activeElement, select, 'Bookmark changes preserve focus');
    changed.emit({ laterOnBookmarkState: { newValue: store.laterOnBookmarkState } }, 'local');
    assert.equal(badge.hidden, false);
    document.querySelector('#searchInput').value = 'climate model';
    document.querySelector('#searchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.deepEqual([...document.querySelectorAll('#cardGrid .card')].map(el => el.dataset.id), ['auto'], 'Search uses the query-based display title');
    assert.equal(JSON.stringify(store.laterOnItems), before, 'The hint and display correction never persist membership or rewrite source items');
    assert.equal(writes, 0);
    console.log('PASS reading library integration: quiet scoped bookmark hint, in-place updates without focus loss, query-based search titles and manual-title preservation');
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

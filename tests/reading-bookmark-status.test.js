const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.resolve(__dirname, '../reading-bookmark-status.js'), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const CONFIG = 'laterOnBookmarkConfig', STATE = 'laterOnBookmarkState';
const url = 'https://example.test/paper?q=one#intro';
const snapshot = (nodes = [{ url }], scopeId = null) => ({ enabled: true, scopeId, nodes });
function fixture(initial = {}, options = {}) {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><article id="card"><span class="source-name">example.test</span><p id="currentSource">example.test</p></article></body></html>', { runScripts: 'outside-only' });
  const store = { [CONFIG]: { enabled: true, scopeId: null }, [STATE]: snapshot(), laterOnItems: [{ url, title: 'Reading original' }], ...initial };
  const originalReading = JSON.stringify(store.laterOnItems), changed = event(), removed = event(), added = event();
  let granted = options.granted !== false, reads = 0, writes = 0, requests = 0;
  const { window } = dom;
  window.chrome = {
    storage: { local: {
      async get(keys) { reads++; return options.get ? options.get(keys) : Object.fromEntries(keys.map(key => [key, store[key]])); },
      async set() { writes++; }
    }, onChanged: changed },
    permissions: { async contains() { return granted; }, onRemoved: removed, onAdded: added, async request() { requests++; } },
    runtime: { async sendMessage() { requests++; } }
  };
  window.eval(source);
  return { dom, window, api: window.LaterOnReadingBookmarkStatus, store,
    source: window.document.querySelector('.source-name'), card: window.document.querySelector('#card'),
    patch(patch, area = 'local') { Object.assign(store, patch); changed.emit(Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, { newValue }])), area); },
    revoke() { granted = false; removed.emit({ permissions: ['bookmarks'] }); },
    grant() { granted = true; added.emit({ permissions: ['bookmarks'] }); },
    assertReadOnly() { assert.equal(reads, 1, 'Membership reads the two cached keys once, not once per card'); assert.equal(writes, 0); assert.equal(requests, 0, 'Never prompts permission or requests native/network work'); assert.equal(JSON.stringify(store.laterOnItems), originalReading); }
  };
}
(async () => {
  const f = fixture();
  try {
    const badge = f.api.attach(f.source, url);
    assert.equal(badge.hidden, true, 'The hint waits for validated cached state');
    await f.api.ready;
    assert.equal(badge.hidden, false);
    assert.equal(badge.getAttribute('role'), 'img');
    assert.equal(badge.getAttribute('aria-label'), '已在书签库中');
    assert.equal(badge.title, '已在书签库中');
    assert.equal(badge.textContent, '', 'The quiet hint adds no label to the source line');
    assert.equal(f.source.classList.contains('has-bookmark-status'), true);
    assert.equal(f.api.attach(f.source, url), badge, 'Repeated card updates reuse the badge DOM');
    assert.equal(f.api.has('https://example.test/paper?q=two#intro'), false, 'Queries remain distinct');
    assert.equal(f.api.has('https://example.test/paper?q=one#other'), false, 'Fragments remain distinct');
    assert.equal(f.api.has('https://example.test/paper?q=one&utm_source=other#intro'), false, 'Tracking parameters remain distinct native bookmarks');
    assert.equal(f.api.urlKey('https://EXAMPLE.test:443'), 'https://example.test/');
    assert.equal(f.api.urlKey('javascript:alert(1)'), '');
    assert.equal(f.api.attach(null, url), null);

    f.window.document.documentElement.lang = 'en';
    f.window.dispatchEvent(new f.window.CustomEvent('lateron-language-change'));
    assert.equal(badge.title, 'Already in Bookmarks');
    assert.equal(badge.getAttribute('aria-label'), 'Already in Bookmarks');
    const current = f.api.attach(f.window.document.querySelector('#currentSource'), url);
    assert.equal(current.hidden, false);

    f.patch({ [STATE]: snapshot([]) });
    assert.equal(badge.hidden, true, 'Removing a bookmark clears the hint immediately');
    assert.equal(f.source.classList.contains('has-bookmark-status'), false);
    assert.equal(current.hidden, true);
    f.patch({ [STATE]: snapshot() });
    assert.equal(badge.hidden, false);
    assert.equal(f.window.document.querySelector('#card'), f.card, 'Membership updates do not replace cards');
    assert.equal(f.source.querySelector('.reading-bookmark-status'), badge);
    f.patch({ [STATE]: { ...snapshot(), error: 'bookmarkRefreshFailed' } });
    assert.equal(badge.hidden, true, 'A stale failed refresh cannot claim current membership');
    f.patch({ [STATE]: snapshot() });

    f.patch({ [CONFIG]: { enabled: true, scopeId: 'new-scope' } });
    assert.equal(badge.hidden, true, 'Changing scope clears the previous snapshot immediately');
    f.patch({ [STATE]: snapshot() });
    assert.equal(badge.hidden, true, 'An old scope response stays hidden');
    f.patch({ [STATE]: snapshot([{ url }], 'new-scope') });
    assert.equal(badge.hidden, false);
    f.patch({ [CONFIG]: { enabled: false, scopeId: 'new-scope' } });
    assert.equal(badge.hidden, true);
    f.patch({ [CONFIG]: { enabled: true, scopeId: 'new-scope' } });
    assert.equal(badge.hidden, true, 'Enabling waits for a fresh snapshot rather than restoring stale hints');
    f.patch({ [STATE]: snapshot([{ url }], 'new-scope') });
    assert.equal(badge.hidden, false);
    f.revoke();
    assert.equal(badge.hidden, true, 'Permission revocation clears the hint synchronously');
    f.patch({ [STATE]: snapshot([{ url }], 'new-scope') });
    assert.equal(badge.hidden, true, 'A late cache write cannot bypass revoked permission');
    f.grant(); await tick();
    assert.equal(badge.hidden, false);

    f.source.textContent = 'Updated source';
    const rebuilt = f.api.attach(f.source, url);
    assert.notEqual(rebuilt, badge);
    assert.equal(rebuilt.hidden, false, 'Source text replacement safely restores the badge');
    f.api.attach(f.source, 'https://other.test/');
    assert.equal(rebuilt.hidden, true, 'A reused card follows its current URL');
    f.assertReadOnly();
  } finally { f.dom.window.close(); }

  for (const initial of [{ [CONFIG]: undefined }, { [STATE]: undefined }, { [STATE]: { ...snapshot(), error: 'bookmarkPermission' } }, { [STATE]: snapshot([{ url }], 'different-scope') }]) {
    const g = fixture(initial);
    try { await g.api.ready; assert.equal(g.api.attach(g.source, url).hidden, true); g.assertReadOnly(); }
    finally { g.dom.window.close(); }
  }
  const denied = fixture({}, { granted: false });
  try { await denied.api.ready; assert.equal(denied.api.attach(denied.source, url).hidden, true); denied.assertReadOnly(); }
  finally { denied.dom.window.close(); }

  let release;
  const race = fixture({}, { get: () => new Promise(resolve => { release = resolve; }) });
  try {
    race.patch({ [CONFIG]: { enabled: false, scopeId: null }, [STATE]: { enabled: false, nodes: [] } });
    release({ [CONFIG]: { enabled: true }, [STATE]: snapshot() });
    await race.api.ready;
    assert.equal(race.api.attach(race.source, url).hidden, true, 'An initial read cannot restore state invalidated by a newer storage event');
    race.assertReadOnly();
  } finally { race.dom.window.close(); }
  const stateRace = fixture({}, { get: () => new Promise(resolve => { release = resolve; }) });
  try {
    const newerUrl = 'https://newer.test/';
    stateRace.patch({ [STATE]: snapshot([{ url: newerUrl }]) });
    release({ [CONFIG]: { enabled: true }, [STATE]: snapshot() });
    await stateRace.api.ready;
    assert.equal(stateRace.api.has(newerUrl), true, 'An early state event merges with the untouched config from the initial read');
    assert.equal(stateRace.api.has(url), false, 'The newer state wins over the initial state snapshot');
    stateRace.assertReadOnly();
  } finally { stateRace.dom.window.close(); }
  console.log('PASS reading bookmark hint: cached scoped membership, conservative URLs, subtle accessible bilingual badges, live in-place updates, scope/permission/error invalidation and reading-data isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });

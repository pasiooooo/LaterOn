const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = path.resolve(__dirname, '../current-page-background.js');
const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'globalThis.LaterOnCurrentPageMetadata = { get: extractTabMetadataById };';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const key = 'laterOnCurrentPageMetadata';
function fixture() {
  let now = 100000, calls = 0, failWrite = false;
  const session = {}, tabs = new Map([[1, { id: 1, windowId: 4, url: 'https://article.test/one', title: 'Native title', status: 'complete' }]]), hooks = {};
  const chrome = { tabs: { async get(id) { if (!tabs.has(id)) throw Error('Closed'); return { ...tabs.get(id) }; }, onUpdated: event(), onRemoved: event() }, storage: { session: {
    async get(name) { return structuredClone({ [name]: session[name] }); },
    async set(patch) { if (failWrite) throw Error('Quota'); Object.assign(session, structuredClone(patch)); }
  } } };
  const metadata = tab => ({ url: tab.url, title: 'Article title', titleFrom: 'dom-headline', description: 'Article summary',
    image: 'https://images.test/article.jpg', favicon: 'https://article.test/favicon.ico', source: 'Article',
    isSaved: true, bookmarkId: 'must-not-share', projectId: 'private-project', read: true });
  function boot() {
    chrome.tabs.onUpdated.listeners = []; chrome.tabs.onRemoved.listeners = [];
    const ctx = vm.createContext({ chrome, URL, console, Date: class extends Date { static now() { return now; } },
      async extractTabMetadataById(id) { calls++; return hooks.extract ? hooks.extract(id) : { ok: true, metadata: metadata(tabs.get(id)) }; }
    });
    vm.runInContext(source, ctx); return ctx.LaterOnCurrentPageMetadata;
  }
  return { chrome, tabs, session, hooks, metadata, boot, get calls() { return calls; }, advance(ms) { now += ms; }, failWrites() { failWrite = true; } };
}
(async () => {
  const f = fixture(); let api = f.boot(), release;
  f.hooks.extract = id => new Promise(resolve => { release = () => resolve({ ok: true, metadata: f.metadata(f.tabs.get(id)) }); });
  const pending = [api.get(1), api.get(1)];
  while (!release) await tick();
  assert.equal(f.calls, 1, 'Reading/bookmark callers share the same in-flight extraction');
  release(); const [first, second] = await Promise.all(pending);
  assert.equal(first.metadata.title, 'Article title'); assert.equal(second.metadata.image, first.metadata.image);
  assert.equal(first.metadata.isSaved, undefined); assert.equal(first.metadata.bookmarkId, undefined);
  delete f.hooks.extract;
  assert.equal((await api.get(1)).metadata.description, 'Article summary'); assert.equal(f.calls, 1);
  assert(f.session[key], 'Facts survive a service-worker restart in session storage');
  assert(!JSON.stringify(f.session).includes('must-not-share')); assert(!JSON.stringify(f.session).includes('private-project'));
  api = f.boot(); assert.equal((await api.get(1)).metadata.title, 'Article title'); assert.equal(f.calls, 1);

  f.tabs.set(2, { ...f.tabs.get(1), id: 2, windowId: 8 });
  await api.get(2); assert.equal(f.calls, 2, 'Tab identity, not only URL, owns the snapshot');
  f.chrome.tabs.onUpdated.emit(1, { status: 'loading' }); f.tabs.get(1).status = 'loading';
  assert.equal((await api.get(1)).ok, false, 'Do not extract the old document while a reload is pending');
  f.tabs.get(1).status = 'complete'; f.chrome.tabs.onUpdated.emit(1, { status: 'complete' });
  await api.get(1); assert.equal(f.calls, 3, 'Same-URL reloads invalidate the cache');
  f.tabs.get(1).title = 'New title'; f.chrome.tabs.onUpdated.emit(1, { title: 'New title' });
  await api.get(1); assert.equal(f.calls, 4);
  f.advance(16 * 60 * 1000); await api.get(1); assert.equal(f.calls, 5, 'Long-lived pages periodically revalidate');

  f.chrome.tabs.onUpdated.emit(1, { status: 'loading' });
  let resolveOld;
  f.hooks.extract = id => new Promise(resolve => { const old = f.metadata(f.tabs.get(id)); resolveOld = () => resolve({ ok: true, metadata: old }); });
  const old = api.get(1); while (!resolveOld) await tick();
  Object.assign(f.tabs.get(1), { url: 'https://article.test/new', title: 'New page' });
  f.chrome.tabs.onUpdated.emit(1, { url: 'https://article.test/new' });
  delete f.hooks.extract; const newest = await api.get(1);
  resolveOld(); assert.equal((await old).ok, false, 'A late old extraction cannot overwrite a new document');
  assert.equal(newest.metadata.url, 'https://article.test/new');
  assert.equal((await api.get(1)).metadata.url, newest.metadata.url);
  f.tabs.delete(1); f.chrome.tabs.onRemoved.emit(1); await tick();
  assert.equal((await api.get(1)).ok, false); assert(!f.session[key]['1']);

  const errors = fixture(), retry = errors.boot();
  errors.hooks.extract = async () => { throw Error('Transient failure'); };
  await assert.rejects(retry.get(1)); delete errors.hooks.extract;
  assert.equal((await retry.get(1)).ok, true, 'A failed request does not poison subsequent attempts');
  errors.failWrites(); errors.tabs.set(3, { ...errors.tabs.get(1), id: 3 });
  assert.equal((await retry.get(3)).ok, true, 'Cache persistence failure does not block usable page metadata');
  for (let id = 4; id < 35; id++) { errors.tabs.set(id, { ...errors.tabs.get(1), id }); await retry.get(id); }
  const bounded = fixture(), limited = bounded.boot();
  for (let id = 1; id < 35; id++) { bounded.tabs.set(id, { ...bounded.tabs.get(1), id }); await limited.get(id); }
  assert(Object.keys(bounded.session[key]).length <= 20);
  assert(JSON.stringify(bounded.session[key]).length * 2 <= 1024 * 1024);
  const settling = fixture(), settlingApi = settling.boot(); let finish;
  settling.hooks.extract = id => new Promise(resolve => { finish = () => resolve({ ok: true, metadata: settling.metadata(settling.tabs.get(id)) }); });
  const settlingResult = settlingApi.get(1); while (!finish) await tick();
  settling.tabs.get(1).favIconUrl = 'https://article.test/new-icon.png';
  settling.chrome.tabs.onUpdated.emit(1, { favIconUrl: settling.tabs.get(1).favIconUrl });
  settling.tabs.get(1).title = 'The finished page title';
  settling.chrome.tabs.onUpdated.emit(1, { title: settling.tabs.get(1).title });
  finish(); assert.equal((await settlingResult).ok, true, 'Late title/icon events must not discard a useful first extraction');
  delete settling.hooks.extract; await settlingApi.get(1);
  assert.equal(settling.calls, 2, 'A changed title still revalidates the next snapshot');
  settling.tabs.set(4, { id: 4, url: 'chrome://settings/', status: 'complete' });
  assert.equal((await settlingApi.get(4)).ok, false); assert.equal(settling.calls, 2, 'Internal pages never trigger extraction');
  const partial = fixture(), partialApi = partial.boot();
  partial.hooks.extract = id => ({ ok: true, metadata: { ...partial.metadata(partial.tabs.get(id)), image: '' } });
  await partialApi.get(1); await partialApi.get(1); assert.equal(partial.calls, 1);
  partial.advance(11000); await partialApi.get(1); assert.equal(partial.calls, 2, 'Incomplete metadata gets a short retry window instead of locking in a missing cover');
  console.log('PASS current-page cache: shared in-flight/session facts, no collection state, document invalidation, restart, expiry, stale results, failures and bounded storage');
})().catch(error => { console.error(error); process.exitCode = 1; });

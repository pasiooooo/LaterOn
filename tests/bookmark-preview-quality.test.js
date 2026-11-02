const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const fixture = require('./bookmark-sync.test');
const png = 'data:image/png;base64,iVBORw0KGgo=';
const url = 'https://example.com/paper';
const setup = () => {
  const f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' }, laterOnItems: [] });
  f.grant();
  return f;
};
const fill = f => f.api.handle({ type: 'BOOKMARKS_PREVIEWS', ids: ['inside'] });
const preview = state => state.nodes.find(node => node.id === 'inside').preview;

(async () => {
  const dom = new JSDOM('<meta property="og:image" content="https://example.com/logo.png"><script type="application/ld+json">{"@type":"Article","image":{"url":"https://images.test/rendered.jpg"},"description":"Rendered article summary"}</script>', { url, runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../content-metadata.js'), 'utf8'));
  const metadata = dom.window.extractPageMetadataForShortcut();
  assert.equal(metadata.image, 'https://images.test/rendered.jpg');
  const open = setup();
  let reads = 0, queries = 0;
  const tab = { id: 7, url, status: 'complete', active: false };
  open.chrome.tabs = {
    async query() { queries++; return [{ ...tab }]; },
    async get() { return { ...tab }; },
    create() { throw Error('Must not open tabs'); }, update() { throw Error('Must not navigate or activate'); }, remove() { throw Error('Must not close tabs'); }
  };
  open.ctx.extractTabMetadata = async (_, options) => { assert.equal(options.serverRescue, false); reads++; return metadata; };
  open.ctx.fetch = async target => {
    assert.equal(target, metadata.image, 'A rendered cover needs no duplicate HTML request');
    return new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  };
  await open.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(reads, 0, 'Entering bookmarks never injects into webpages');
  let state = await fill(open);
  assert.equal(preview(state).description, metadata.description, 'Explicit enrichment reuses the real add-page extractor');
  assert(preview(state).image.startsWith('data:image/png;base64,'));
  assert.equal(state.nodes.find(node => node.id === 'inside').title, 'Paper');
  assert.equal(reads, 1); assert.equal(queries, 1);
  assert.deepEqual(open.store.laterOnItems, []);
  open.ctx.extractTabMetadata = async () => ({ ...metadata, image: 'https://images.test/icon.png' });
  open.ctx.fetch = async target => {
    if (target === url) return new Response('<meta property="og:image" content="https://images.test/article.jpg">', { headers: { 'content-type': 'text/html' } });
    assert.equal(target, 'https://images.test/article.jpg', 'A site icon from a stale DOM does not suppress the HTML cover fallback');
    return new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  };
  assert(preview(await fill(open)).image);
  open.ctx.extractTabMetadata = async (_, options) => { assert.equal(options.serverRescue, false); reads++; return metadata; };

  for (const [html, image] of [
    ['<base href="https://images.test/assets/"><meta property="og:image:url" content="cover.jpg"><meta name="twitter:description" content="Static summary">', 'https://images.test/assets/cover.jpg'],
    ['<meta property="og:image" content="/logo.png"><script type="application/ld+json">{"@graph":[{"@type":"Article","image":{"contentUrl":"https://images.test/structured.jpg"},"description":"Structured summary"}]}</script>', 'https://images.test/structured.jpg'],
    ['<link rel="image_src" href="/article.jpg">', 'https://example.com/article.jpg'],
    ['<video poster="/poster.jpg"></video>', 'https://example.com/poster.jpg'],
    ['<img width="1" height="1" src="/tracking.png"><img width="900" height="600" data-src="/lazy.jpg">', 'https://example.com/lazy.jpg']
  ]) {
    const staticPage = setup(); let requested = false;
    staticPage.ctx.fetch = async target => {
      if (target === url) return new Response(html, { headers: { 'content-type': 'text/html' } });
      assert.equal(target, image); requested = true;
      return new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    };
    const result = await fill(staticPage);
    assert(requested, 'Static fallback supports structured, alternate, poster and lazy image metadata');
    assert(preview(result).image);
  }

  for (const extra of [{ discarded: true }, { frozen: true }, { status: 'loading' }, { pendingUrl: 'https://elsewhere.test/' }]) {
    Object.assign(tab, { discarded: false, frozen: false, status: 'complete', pendingUrl: undefined }, extra);
    const before = reads;
    open.ctx.fetch = async () => new Response('<meta name="description" content="Static fallback">', { headers: { 'content-type': 'text/html' } });
    state = await fill(open);
    assert.equal(reads, before, 'Unloaded, frozen and navigating tabs are left untouched');
    assert.equal(preview(state).description, 'Static fallback');
  }
  Object.assign(tab, { discarded: false, frozen: false, status: 'complete', pendingUrl: undefined, url });
  open.ctx.extractTabMetadata = async () => { tab.url = 'https://elsewhere.test/'; return metadata; };
  state = await fill(open);
  assert.equal(preview(state).description, 'Static fallback', 'Navigation during extraction discards rendered metadata');
  tab.url = url;
  open.ctx.extractTabMetadata = async () => ({ ...metadata, url: 'https://elsewhere.test/' });
  state = await fill(open);
  assert.equal(preview(state).description, 'Static fallback', 'The actual document URL must match as well as the tab snapshot');
  dom.window.close();

  const cached = setup();
  await cached.ctx.LaterOnBookmarkPreviews.commit([{ id: 'inside', url, description: 'Old summary', error: true }], cached.nodes, 0);
  cached.store.laterOnItems = [{ id: 'reading', url, image: 'local://reading', description: 'Reading summary' }];
  cached.store.laterOnCovers = { reading: png };
  cached.ctx.fetch = () => { throw Error('Local reuse must not fetch'); };
  state = await cached.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(preview(state).image, png, 'An incomplete cached preview can acquire a cover saved later in the reading library');
  assert.equal(preview(state).description, 'Old summary', 'Local reuse only fills missing fields');

  const remote = setup();
  remote.store.laterOnItems = [{ id: 'reading', url, image: 'https://images.test/reading.jpg' }];
  remote.ctx.fetch = async target => {
    if (target === url) throw Error('HTML unavailable');
    assert.equal(target, 'https://images.test/reading.jpg');
    return new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  };
  state = await fill(remote);
  assert(preview(state).image, 'An explicitly requested preview can reuse a remote cover URL known to the reading library');

  const large = setup();
  let closed = 0, canvasSize;
  large.ctx.createImageBitmap = async blob => { assert(blob.size > 512 * 1024); return { width: 2400, height: 1600, close() { closed++; } }; };
  large.ctx.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; canvasSize = [w, h]; }
    getContext() { return { drawImage(bitmap, x, y, w, h) { assert.deepEqual([w, h], [1024, 683]); } }; }
    async convertToBlob(options) { assert.equal(options.type, 'image/webp'); return new Blob([new Uint8Array(24)], { type: 'image/webp' }); }
  };
  large.ctx.fetch = async target => target.endsWith('.jpg')
    ? new Response(Buffer.alloc(700 * 1024, 65), { headers: { 'content-type': 'image/jpeg' } })
    : new Response('<meta property="og:image" content="https://images.test/large.jpg">', { headers: { 'content-type': 'text/html' } });
  state = await fill(large);
  assert(preview(state).image.startsWith('data:image/webp;base64,'), 'Large covers are reduced to bounded local thumbnails');
  assert.deepEqual(canvasSize, [1024, 683]); assert.equal(closed, 1);
  assert(preview(state).image.length < 768 * 1024);
  console.log('PASS bookmark preview quality: shared rendered extractor, no tab mutation, navigation guards, later local-cover reuse and large-image thumbnails');
})().catch(error => { console.error(error); process.exitCode = 1; });

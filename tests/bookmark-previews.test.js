const assert = require('node:assert/strict');
const fixture = require('./bookmark-sync.test');
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
(async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' }, laterOnItems: [
    { id: 'r', url: 'https://example.com/paper', title: 'Different reading title', description: 'Local abstract', image: 'local://r' }
  ], laterOnCovers: { r: png } });
  f.grant();
  let fetched = 0;
  f.ctx.fetch = async () => { fetched++; throw new Error('Unexpected automatic fetch'); };
  let state = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(fetched, 0, 'Reading the native snapshot queues work without blocking on network requests');
  assert.equal(state.nodes.find(node => node.id === 'inside').title, 'Paper', 'Native titles remain authoritative');
  assert.equal(state.nodes.find(node => node.id === 'inside').preview.image, png);
  assert.equal(state.nodes.find(node => node.id === 'inside').preview.description, 'Local abstract');
  delete f.store.laterOnCovers;
  f.store.laterOnItems = [];
  state = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(state.nodes.find(node => node.id === 'inside').preview.image, png, 'Copied local previews survive reading wipe');
  for (const url of ['http://localhost/a', 'http://127.1/a', 'http://10.0.0.1/a', 'http://172.16.4.1/a', 'http://192.168.1.1/a', 'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'https://user:pass@example.com/', 'https://:preview@example.com/', 'file:///a', 'https://printer.local/a']) {
    assert.equal(f.ctx.LaterOnBookmarkPreviews.publicUrl(url), '', `Reject private/credential-bearing URL: ${url}`);
  }
  const beforeNative = JSON.stringify(f.nodes);
  for (const url of ['http://router.home.arpa/private', 'http://[fec0::1]/private', 'http://[ff02::1]/private', 'http://[2001:db8::1]/a', 'http://[2002:7f00:1::]/a']) {
    assert.equal(f.ctx.LaterOnBookmarkPreviews.publicUrl(url), '', `Reject special-use addresses: ${url}`);
  }
  f.ctx.fetch = async (url, options) => {
    fetched++;
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'follow');
    assert.equal(options.referrerPolicy, 'no-referrer');
    if (url.endsWith('cover.png')) return new Response(Buffer.from([137,80,78,71]), { headers: { 'content-type': 'image/png' } });
    return new Response('<html><head><meta property="og:image" content="https://images.test/cover.png"><meta name="description" content="Fetched &amp; safe"></head></html>', { headers: { 'content-type': 'text/html' } });
  };
  state = await f.api.handle({ type: 'BOOKMARKS_PREVIEWS', ids: ['inside'] });
  assert.equal(state.previewResults.updated, 1);
  const preview = state.nodes.find(node => node.id === 'inside').preview;
  assert.equal(preview.description, 'Fetched & safe');
  assert(preview.image.startsWith('data:image/png;base64,'));
  assert.equal(JSON.stringify(f.nodes), beforeNative, 'Preview retrieval never edits native bookmarks');
  assert.equal(f.store.laterOnItems.length, 0, 'Preview retrieval never creates reading items');

  let imageRequests = 0;
  f.ctx.fetch = async (url, options) => {
    if (url.includes('127.0.0.1')) imageRequests++;
    return new Response('<meta property="og:image" content="http://127.0.0.1/private.png">', { headers: { 'content-type': 'text/html' } });
  };
  await f.api.handle({ type: 'BOOKMARKS_PREVIEWS', ids: ['inside'] });
  assert.equal(imageRequests, 0, 'Derived image URLs receive the same public-URL validation');
  f.ctx.fetch = async () => { await f.chrome.bookmarks.update('inside', { url: 'https://changed.test/' }); return new Response('<meta name="description" content="Stale">', { headers: { 'content-type': 'text/html' } }); };
  await f.api.handle({ type: 'BOOKMARKS_PREVIEWS', ids: ['inside'] });
  state = await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert(!state.nodes.find(node => node.id === 'inside').preview, 'A changed native URL never receives stale preview data');

  const g = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: null } });
  g.grant();
  let active = 0, peak = 0, calls = 0;
  g.ctx.fetch = async () => { calls++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return new Response('<meta name="description" content="Preview">', { headers: { 'content-type': 'text/html' } }); };
  await Promise.all([g.api.handle({ type: 'BOOKMARKS_PREVIEWS', ids: ['inside', 'outside', 'policy'] }), g.api.handle({ type: 'BOOKMARKS_PREVIEWS', ids: ['inside', 'outside'] })]);
  assert(peak <= 2, `Global concurrency is bounded across callers: ${peak}`);
  assert.equal(calls, 3, 'Concurrent requests for the same node and URL share network work');
  let release;
  g.ctx.fetch = async () => { await new Promise(resolve => { release = resolve; }); return new Response('<meta name="description" content="No commit after disable">', { headers: { 'content-type': 'text/html' } }); };
  const pending = g.api.handle({ type: 'BOOKMARKS_PREVIEWS', ids: ['outside'] });
  while (!release) await wait();
  await g.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: false });
  release();
  await pending;
  assert(!JSON.stringify(g.store.laterOnBookmarkPreviews).includes('No commit after disable'));
  console.log('PASS bookmark previews: local reuse, permanent copied covers, bounded fetches, public URL checks, deduplication, native isolation and stale-result rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fixture = require('./bookmark-sync.test');
const node = { id: 'preview', url: 'https://example.com/preview' };
const allow = async () => {};

(async () => {
  const timed = fixture();
  let aborted = false;
  timed.ctx.setTimeout = (callback, milliseconds) => {
    assert.equal(milliseconds, 8000, 'Each remote response has an eight-second deadline');
    return setTimeout(callback, 1);
  };
  timed.ctx.fetch = (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }, { once: true });
  });
  assert((await timed.ctx.LaterOnBookmarkPreviews.load([node], allow))[0].error);
  assert(aborted, 'The deadline aborts the underlying request, not only the caller promise');

  const invalidated = fixture();
  let calls = 0;
  invalidated.ctx.fetch = async () => { calls++; throw new Error('Must not fetch'); };
  const cancelled = await invalidated.ctx.LaterOnBookmarkPreviews.load([node], async () => invalidated.ctx.LaterOnBookmarkPreviews.cancel());
  assert(cancelled[0].error);
  assert.equal(calls, 0, 'Cancellation while checking native access prevents the request from starting');

  const redirected = fixture();
  redirected.ctx.fetch = async (_, options) => {
    assert.equal(options.redirect, 'follow', 'Use browser-supported reading/CDN redirect behavior');
    const response = new Response('<meta name="description" content="Must not consume private response">', { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: 'http://127.0.0.1/private' });
    return response;
  };
  assert((await redirected.ctx.LaterOnBookmarkPreviews.load([node], allow))[0].error, 'Reject a recognizable private final response before reading its body');

  const html = fixture();
  let reads = 0, cancellations = 0;
  const prefix = Buffer.from('<meta name="description" content="Inside the byte limit">');
  html.ctx.fetch = async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }), body: { getReader: () => ({
    async read() { reads++; return { done: false, value: reads === 1 ? prefix : Buffer.alloc(256 * 1024, 97) }; },
    async cancel() { cancellations++; }
  }) } });
  const clipped = (await html.ctx.LaterOnBookmarkPreviews.load([node], allow))[0];
  assert.equal(clipped.description, 'Inside the byte limit');
  assert.equal(reads, 2, 'Stop reading HTML once the 256 KiB budget is filled');
  assert.equal(cancellations, 1, 'Oversized HTML cancels its stream');

  const image = fixture();
  let imageReads = 0, imageCancellations = 0;
  image.ctx.fetch = async url => url.endsWith('.png') ? {
    ok: true, headers: new Headers({ 'content-type': 'image/png' }), body: { getReader: () => ({
      async read() { imageReads++; return { done: false, value: Buffer.alloc(4 * 1024 * 1024 + 1) }; },
      async cancel() { imageCancellations++; }
    }) }
  } : new Response('<meta name="description" content="Keep the summary"><meta property="og:image" content="https://images.test/large.png">', { headers: { 'content-type': 'text/html' } });
  const oversized = (await image.ctx.LaterOnBookmarkPreviews.load([node], allow))[0];
  assert.equal(oversized.description, 'Keep the summary');
  assert.equal(oversized.image, '', 'An oversized image is rejected, never rendered as truncated bytes');
  assert.equal(imageReads, 1);
  assert.equal(imageCancellations, 1);

  const cached = fixture();
  const previews = cached.ctx.LaterOnBookmarkPreviews;
  const records = Array.from({ length: 301 }, (_, i) => ({ id: String(i), url: `https://example.com/${i}`, description: 'Cached summary' }));
  await previews.commit(records, records, previews.epoch);
  assert.equal(Object.keys(cached.store.laterOnBookmarkPreviews).length, 300, 'The preview cache has at most 300 entries');
  const large = Array.from({ length: 12 }, (_, i) => ({ id: `large-${i}`, url: `https://example.com/large-${i}`, image: 'data:image/png;base64,' + 'A'.repeat(512 * 1024) }));
  await previews.commit(large, large, previews.epoch);
  const stored = cached.store.laterOnBookmarkPreviews;
  assert(Object.keys(stored).length > 0 && Object.keys(stored).length < large.length, 'Large covers trigger byte-budget eviction');
  assert(Object.values(stored).reduce((size, value) => size + JSON.stringify(value).length * 2, 0) <= 8 * 1024 * 1024);
  assert(!Object.keys(stored).some(key => !key.startsWith('large-')), 'Deleted or changed native nodes do not retain previews');
  console.log('PASS bookmark preview bounds: real abort, cancellation during access checks, streamed HTML/image limits and count/byte cache budgets');
})().catch(error => { console.error(error); process.exitCode = 1; });

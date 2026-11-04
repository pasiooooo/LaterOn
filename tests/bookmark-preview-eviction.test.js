const assert = require('node:assert/strict');
const fixture = require('./bookmark-sync.test');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const until = async (check, message) => { for (let i = 0; i < 200 && !check(); i++) await tick(); assert(check(), message); };
const image = 'data:image/png;base64,iVBORw0KGgo=';
const pages = Array.from({ length: 1000 }, (_, i) => ({ id: `page-${i}`, parentId: '2', title: `Page ${i}`, url: `https://example.test/${i}` }));
const cached = Object.fromEntries(pages.slice(0, 300).map(node => [node.id, { url: node.url, image, description: 'Complete preview', updatedAt: 1 }]));
const config = { laterOnBookmarkConfig: { enabled: true, scopeId: null }, laterOnItems: [], laterOnBookmarkPreviews: cached };
(async () => {
  const failed = fixture(config); failed.nodes.push(...pages); failed.ctx.fetch = async () => { throw Error('Unavailable'); }; failed.grant();
  await failed.api.handle({ type: 'BOOKMARKS_GET' });
  const before = failed.store.laterOnBookmarkPreviewQueue.pending.length;
  failed.chrome.alarms.onAlarm.emit({ name: 'laterOnBookmarkPreviews' });
  await until(() => Object.keys(failed.store.laterOnBookmarkPreviewQueue.attempted).length === 12, 'Failure batch completes');
  assert.equal(Object.values(failed.store.laterOnBookmarkPreviews).filter(preview => preview.image).length, 300, 'Recent failures cannot evict useful cached covers');
  assert.equal(failed.store.laterOnBookmarkPreviewQueue.pending.length, before - 12, 'Failed jobs do not requeue already cached covers through eviction');

  for (const available of [true, false]) {
    const knownCover = 'https://images.test/reading-cover.png';
    const reading = fixture({ ...config, laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' },
      laterOnItems: [{ id: 'reading', url: 'https://example.com/paper', image: knownCover, description: 'Known reading abstract' }] });
    reading.nodes.push(...pages); reading.grant(); await reading.api.handle({ type: 'BOOKMARKS_GET' });
    assert(!reading.store.laterOnBookmarkPreviews.inside, 'A full cover cache can evict a source-only preview record');
    const calls = [];
    reading.ctx.fetch = async url => {
      calls.push(url);
      if (url !== knownCover || !available) throw Error('Unavailable');
      return new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    };
    await reading.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['inside'], viewKey: 'reading-cover' });
    await until(() => reading.store.laterOnBookmarkPreviewQueue.attempted.inside, 'Known reading-cover attempt commits');
    assert.equal(calls.filter(url => url === knownCover).length, 1, 'A known reading cover is attempted once even if its source-only cache record was evicted');
    if (available) {
      assert(reading.store.laterOnBookmarkPreviews.inside?.image, 'Known reading cover remains obtainable when static HTML is unavailable');
      assert.equal(calls.length, 1, 'A complete reading preview needs no duplicate HTML request');
    } else {
      assert(!reading.store.laterOnBookmarkPreviews.inside, 'Image-first budgeting may discard the failed source-only record');
      assert.equal(reading.store.laterOnBookmarkPreviewQueue.attempted.inside.sourceImage, knownCover, 'The durable attempt retains a source evicted from the image cache');
      await reading.api.handle({ type: 'BOOKMARKS_GET' });
      await reading.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['inside'], viewKey: 'reading-cover-revisit' });
      await tick(); await tick();
      assert.equal(calls.filter(url => url === knownCover).length, 1, 'Source eviction cannot bypass the failure cooldown on refresh or revisit');
    }
  }

  const successful = pages.slice(0, 400);
  const attempted = Object.fromEntries(successful.map(node => [node.id, { url: node.url, at: Date.now(), sourceImage: '', complete: true }]));
  attempted.outside = { url: 'https://outside.test', at: Date.now(), sourceImage: '', complete: false };
  attempted.inside = { url: 'https://example.com/paper', at: Date.now(), sourceImage: '', complete: false };
  attempted.policy = { url: 'https://policy.test', at: Date.now(), sourceImage: '', complete: false };
  const f = fixture({ ...config, laterOnBookmarkPreviewQueue: { pending: [], attempted } });
  f.nodes.push(...successful); f.grant(); await f.api.handle({ type: 'BOOKMARKS_GET' });
  const priority = (viewKey, ids) => f.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, viewKey, ids });
  await priority('view-a', successful.slice(0, 144).map(node => node.id));
  assert.equal(f.store.laterOnBookmarkPreviewQueue.visible.length, 144, 'Visible pins are bounded');
  await f.ctx.LaterOnBookmarkPreviews.commit(successful.slice(300).map(node => ({ ...node, image, description: 'New preview' })), f.nodes, f.ctx.LaterOnBookmarkPreviews.epoch);
  assert.equal(Object.keys(f.store.laterOnBookmarkPreviews).length, 300);
  assert(successful.slice(0, 144).every(node => f.store.laterOnBookmarkPreviews[node.id]?.image), 'Background covers preserve the currently visible successful entries');
  const revisit = successful[250];
  assert(!f.store.laterOnBookmarkPreviews[revisit.id], 'The count cap evicts an older non-visible successful cover');
  await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(f.store.laterOnBookmarkPreviewQueue.pending.length, 0, 'Background refresh alone cannot cycle evicted successes back into the full cache');
  const requests = [];
  f.ctx.fetch = async url => {
    requests.push(url);
    return url.endsWith('.png') ? new Response(Buffer.from([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }) :
      new Response('<meta name="description" content="Restored"><meta property="og:image" content="https://images.test/cover.png">', { headers: { 'content-type': 'text/html' } });
  };
  await priority('view-b', [revisit.id, 'outside']);
  await until(() => f.store.laterOnBookmarkPreviews[revisit.id]?.image && f.store.laterOnBookmarkPreviewQueue.pending.length === 0, 'Revisiting restores the evicted successful cover immediately');
  assert.equal(requests.length, 2);
  assert.equal(requests[0], revisit.url);
  assert(!requests.includes('https://outside.test'), 'Changing views preserves the cooldown for unavailable/incomplete previews');

  delete f.store.laterOnBookmarkPreviews[revisit.id];
  await f.api.handle({ type: 'BOOKMARKS_GET' });
  await priority('view-b', [revisit.id, 'outside']); await tick(); await tick();
  assert.equal(requests.length, 2, 'Same-view refreshes cannot cause refetch/eviction feedback when a byte budget is exhausted');
  await priority('view-c', []);
  await priority('view-b', [revisit.id, 'outside']);
  await until(() => requests.length === 4 && f.store.laterOnBookmarkPreviews[revisit.id]?.image, 'A subsequent deliberate revisit remains immediately eligible');

  const restarted = fixture(f.store); restarted.nodes.push(...successful); restarted.grant(); await restarted.api.handle({ type: 'BOOKMARKS_GET' });
  await restarted.ctx.LaterOnBookmarkPreviews.commit(successful.filter(node => node.id !== revisit.id).slice(0, 300)
    .map(node => ({ ...node, image, description: 'After restart' })), restarted.nodes, restarted.ctx.LaterOnBookmarkPreviews.epoch);
  assert(restarted.store.laterOnBookmarkPreviews[revisit.id]?.image, 'Persisted visible pins survive worker restart');
  assert(Object.keys(restarted.store.laterOnBookmarkPreviews).length <= 300);
  console.log('PASS bookmark preview eviction: useful-cover retention, bounded visible pins, restart recovery, immediate revisit and no redraw feedback');
})().catch(error => { console.error(error); process.exitCode = 1; });

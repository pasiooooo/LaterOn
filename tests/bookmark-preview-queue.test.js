const assert = require('node:assert/strict');
const fixture = require('./bookmark-sync.test');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const until = async (check, message) => { for (let i = 0; i < 200 && !check(); i++) await tick(); assert(check(), message); };
const config = { laterOnBookmarkConfig: { enabled: true, scopeId: null }, laterOnItems: [] };
const pages = Array.from({ length: 80 }, (_, i) => ({ id: `bulk-${i}`, parentId: '2', title: `Page ${i}`, url: `https://example.test/${i}` }));
function network(f, hold = false) {
  const calls = [], releases = []; let active = 0, peak = 0;
  f.ctx.fetch = async url => {
    calls.push(url); active++; peak = Math.max(peak, active);
    if (hold && calls.length <= 2) await new Promise(resolve => releases.push(resolve));
    else await tick();
    active--;
    return new Response('<meta name="description" content="Summary without cover">', { headers: { 'content-type': 'text/html' } });
  };
  return { calls, release() { for (const release of releases) release(); }, get peak() { return peak; } };
}
(async () => {
  const f = fixture(config); f.nodes.push(...pages); const net = network(f, true); f.grant();
  await f.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(net.calls.length, 0, 'Connecting queues native identities without starting a request per bookmark');
  assert.equal(f.store.laterOnBookmarkPreviewQueue.pending.length, 83);
  let previewReads = 0, trees = 0, stateReads = 0;
  const read = f.ctx.LaterOnBookmarkPreviews.read;
  f.ctx.LaterOnBookmarkPreviews.read = (...args) => { previewReads++; return read(...args); };
  const getTree = f.native.getTree, storageGet = f.chrome.storage.local.get;
  f.native.getTree = async (...args) => { trees++; return getTree(...args); };
  f.chrome.storage.local.get = async keys => { if ([].concat(keys).includes('laterOnBookmarkState')) stateReads++; return storageGet(keys); };
  const reply = await f.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['bulk-79', 'bulk-78'] });
  assert.deepEqual(Object.keys(reply).sort(), ['pending', 'prioritized', 'visible'], 'Visible-page priority replies with counts, never the mirror');
  assert.equal(reply.visible, 2);
  assert.equal(trees, 0, 'Prioritizing visible pages reads only those native nodes, not the tree');
  assert.equal(previewReads, 0);
  assert.equal(stateReads, 0, 'Prioritizing never reads the full bookmark mirror');
  await until(() => net.calls.length === 2, 'Visible priorities start immediately');
  assert.deepEqual(new Set(net.calls), new Set(['https://example.test/78', 'https://example.test/79']));
  assert.equal(f.store.laterOnBookmarkPreviewQueue.pending.length, 83, 'In-flight jobs remain durable until committed');
  net.release();
  await until(() => f.store.laterOnBookmarkPreviewQueue.pending.length === 71, 'One wake processes a bounded batch');
  assert.equal(net.calls.length, 12);
  // Without a device-local index the batch republishes the mirror (legacy):
  // one tree read to commit and prune, one to republish. Per-job guards read
  // only the job's native node.
  assert.equal(trees, 2, 'A batch of twelve jobs reads the native tree a bounded number of times, not per job');
  assert.equal(previewReads, 1, 'Only the legacy republish re-derives the preview cache');
  assert(net.peak <= 2, 'At most two page jobs run together');

  const restarted = fixture(f.store); restarted.nodes.push(...pages); const resumed = network(restarted); restarted.grant();
  await restarted.api.handle({ type: 'BOOKMARKS_GET' });
  assert.equal(restarted.store.laterOnBookmarkPreviewQueue.pending.length, 71, 'Restart preserves pending jobs and completed attempts');
  for (let left = 71; left > 0;) {
    restarted.chrome.alarms.onAlarm.emit({ name: 'laterOnBookmarkPreviews' });
    left = Math.max(0, left - 12);
    await until(() => restarted.store.laterOnBookmarkPreviewQueue.pending.length === left, 'Alarm resumes the next bounded batch');
  }
  assert.equal(resumed.calls.length, 71);
  assert(resumed.peak <= 2);
  await restarted.api.handle({ type: 'BOOKMARKS_GET' });
  restarted.chrome.alarms.onAlarm.emit({ name: 'laterOnBookmarkPreviews' });
  await tick(); await tick();
  assert.equal(resumed.calls.length, 71, 'Incomplete sites do not re-enter the queue on each refresh');
  assert.equal(Object.keys(restarted.store.laterOnBookmarkPreviewQueue.attempted).length, 83);
  assert.equal(restarted.nodes.length, 89, 'Fetching previews never creates or removes native bookmarks');
  assert.deepEqual(restarted.store.laterOnItems, [], 'Preview work stays outside the reading library');

  const cancelled = fixture(config); const waiting = [];
  cancelled.ctx.fetch = (_, { signal }) => new Promise((resolve, reject) => {
    waiting.push(resolve); signal.addEventListener('abort', () => reject(Error('Cancelled')), { once: true });
  });
  cancelled.grant(); await cancelled.api.handle({ type: 'BOOKMARKS_GET' });
  await cancelled.api.handle({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids: ['inside'] });
  await until(() => waiting.length === 2, 'Cancellation fixture starts two jobs');
  await cancelled.api.handle({ type: 'BOOKMARKS_CONFIG', enabled: false });
  await tick(); await tick();
  assert.equal(cancelled.store.laterOnBookmarkPreviewQueue.pending.length, 0);
  assert(!cancelled.store.laterOnBookmarkPreviews || !Object.keys(cancelled.store.laterOnBookmarkPreviews).length, 'Disable discards in-flight results');
  console.log('PASS bookmark preview queue: visible priority, two workers, bounded batches, restart recovery, cooldown and cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });

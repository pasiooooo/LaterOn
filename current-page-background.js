// Shared page facts only. Reading/bookmark membership is deliberately not cached here.
(() => {
  const KEY = 'laterOnCurrentPageMetadata', MAX_ENTRIES = 20, MAX_BYTES = 1024 * 1024;
  const TTL = 15 * 60 * 1000, WEAK_TTL = 10000;
  const fields = ['url', 'title', 'titleFrom', 'description', 'image', 'imageFrom', 'favicon', 'source'];
  const pending = new Map();
  let cache = null, queue = Promise.resolve(), sequence = 0;
  const facts = metadata => Object.fromEntries(fields.filter(key => typeof metadata?.[key] === 'string').map(key => [key, metadata[key]]));
  const signature = tab => JSON.stringify([tab.url, tab.title || '']);
  const ready = tab => tab && tab.status !== 'loading' && !tab.pendingUrl;
  const stale = () => ({ ok: false, stale: true });
  function serial(task) {
    const work = queue.then(async () => {
      if (cache === null) {
        try { cache = (await chrome.storage.session?.get(KEY))?.[KEY] || {}; } catch { cache = {}; }
        sequence = Math.max(0, ...Object.values(cache).map(record => Number(record?.order) || 0));
      }
      return task();
    });
    queue = work.catch(() => {}); return work;
  }
  async function persist() {
    let bytes = 0, count = 0;
    cache = Object.fromEntries(Object.entries(cache).sort((a, b) => (b[1]?.order || 0) - (a[1]?.order || 0)).filter(([id, record]) => {
      if (!Number.isFinite(record?.expiresAt) || record.expiresAt <= Date.now()) return false;
      const size = (JSON.stringify(record).length + id.length + 4) * 2;
      if (count >= MAX_ENTRIES || bytes + size > MAX_BYTES) return false;
      count++; bytes += size; return true;
    }));
    try { await chrome.storage.session?.set({ [KEY]: cache }); } catch { /* A cache failure must not prevent adding the current page. */ }
  }
  async function run(tab, job) {
    const cached = await serial(() => {
      const record = cache[tab.id];
      return !job.invalidated && record?.signature === job.signature && record.expiresAt > Date.now() ? facts(record.metadata) : null;
    });
    if (job.invalidated) return stale();
    let current;
    try { current = await chrome.tabs.get(tab.id); } catch { return stale(); }
    if (!ready(current) || current.url !== tab.url || job.invalidated) return stale();
    if (cached?.url === tab.url && signature(current) === job.signature) return { ok: true, metadata: cached, cached: true };
    if (current.discarded || current.frozen) return stale();
    const response = await extractTabMetadataById(tab.id);
    try { current = await chrome.tabs.get(tab.id); } catch { return stale(); }
    if (job.invalidated || !ready(current) || current.url !== tab.url) return stale();
    if (!response?.ok) return response || stale();
    const metadata = facts(response.metadata);
    if (metadata.url !== tab.url) return stale();
    const complete = metadata.image && metadata.description && metadata.description !== '暂无摘要';
    await serial(async () => {
      if (job.invalidated || signature(current) !== job.signature) return;
      cache[tab.id] = { signature: job.signature, metadata, order: ++sequence, expiresAt: Date.now() + (complete ? TTL : WEAK_TTL) };
      await persist();
    });
    return job.invalidated ? stale() : { ok: true, metadata, cached: false };
  }
  async function get(tabId) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return stale(); }
    if (!/^https?:\/\//i.test(tab.url || '') || !ready(tab)) return stale();
    const key = signature(tab), existing = pending.get(tabId);
    if (existing && !existing.invalidated && existing.signature === key) return existing.promise;
    if (existing) existing.invalidated = true;
    const job = { signature: key, invalidated: false };
    pending.set(tabId, job);
    job.promise = run(tab, job).finally(() => { if (pending.get(tabId) === job) pending.delete(tabId); });
    return job.promise;
  }
  function invalidate(tabId, cancelPending = true) {
    const job = pending.get(tabId);
    if (job && cancelPending) job.invalidated = true;
    serial(async () => {
      if (!Object.hasOwn(cache, tabId)) return;
      delete cache[tabId]; await persist();
    }).catch(() => {});
  }
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status === 'loading' || change.status === 'complete' || typeof change.url === 'string') invalidate(id);
    else if (typeof change.title === 'string') invalidate(id, false);
  });
  chrome.tabs.onRemoved.addListener(invalidate);
  globalThis.LaterOnCurrentPageMetadata = { get };
})();

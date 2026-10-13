// Durable, local-only metadata jobs. Network retrieval never holds the item write
// queue; only the final read/merge/write shares it with saves and WebDAV.
(function () {
  const KEY = "laterOnImportMetadata", OWNER = "laterOnImportMetadataTab";
  const ALARM = "laterOnImportMetadata";
  let running = null, rerun = false;
  const normalize = url => LaterOnUrl.normalize(url);
  function missing(item) {
    return {
      title: !item.titleEdited && isPlaceholderText(item.title, item.source),
      description: !item.descriptionEdited && (!item.description || item.description === "暂无摘要"),
      image: !item.imageEdited && (!item.image || isIconLikeImage(item.image)),
      favicon: !item.favicon
    };
  }
  const needsMetadata = item => Object.values(missing(item)).some(Boolean);
  function enqueue(previous, items) {
    const state = previous?.pending?.length ? { ...previous, pending: [...previous.pending] }
      : { pending: [], total: 0, completed: 0, updated: 0, incomplete: 0 };
    const queued = new Set(state.pending.map(job => job.id));
    let count = 0;
    for (const item of items) {
      if (!needsMetadata(item) || queued.has(item.id)) continue;
      queued.add(item.id);
      state.pending.push({ id: item.id, url: item.url });
      state.total++; count++;
    }
    if (count) { state.phase = "queued"; state.updatedAt = Date.now(); }
    return { state, count };
  }
  async function readMetadata(job) {
    let metadata = { url: job.url };
    try {
      // Read an existing, loaded page only. Never create, navigate, activate,
      // unfreeze or close tabs to enrich an imported URL.
      const tab = (await chrome.tabs.query({})).find(tab =>
        !tab.discarded && tab.status === "complete" && normalize(tab.url) === normalize(job.url));
      if (tab) {
        const extracted = await extractTabMetadata(tab);
        const current = await chrome.tabs.get(tab.id);
        if (normalize(current.url) === normalize(job.url)) metadata = { ...extracted, url: job.url };
      }
    } catch { /* A closed/navigated or inaccessible tab can still be fetched. */ }
    if (needsMetadata(metadata)) {
      try {
        metadata = fillMissing(metadata, await refetchMetaFromServer(job.url));
      } catch { /* Keep partial metadata when the server is unavailable. */ }
    }
    return metadata;
  }
  function fillMissing(current, metadata) {
    const next = { ...current };
    if (!metadata) return next;
    const fields = missing(current), candidate = { ...current };
    // Reuse normal-save metadata quality checks and manual-edit locks, but
    // copy back only missing fields (even for YouTube's refresh policy).
    mergeDuplicateMetadata(candidate, metadata);
    for (const key of ["title", "description", "image"]) if (fields[key]) next[key] = candidate[key];
    if (fields.favicon && metadata.favicon) next.favicon = metadata.favicon;
    if ((!next.source || next.source === safeHostname(next.url)) && metadata.source) next.source = metadata.source;
    return next;
  }
  async function complete(job, metadata) {
    await queueItemWrite(async () => {
      const stored = await chrome.storage.local.get([KEY, "laterOnItems"]);
      const state = stored[KEY];
      if (!state?.pending?.some(entry => entry.id === job.id && entry.url === job.url)) return;
      const items = stored.laterOnItems || [];
      const index = items.findIndex(item => item.id === job.id && normalize(item.url) === normalize(job.url));
      let updated = 0, incomplete = 0;
      if (index >= 0) {
        const next = fillMissing(items[index], metadata);
        if (JSON.stringify(next) !== JSON.stringify(items[index])) { items[index] = next; updated = 1; }
        incomplete = needsMetadata(next) ? 1 : 0;
      }
      const pending = state.pending.filter(entry => entry.id !== job.id || entry.url !== job.url);
      const patch = { [KEY]: { ...state, pending, completed: state.completed + 1,
        updated: state.updated + updated, incomplete: state.incomplete + incomplete,
        phase: pending.length ? "running" : "complete", updatedAt: Date.now() } };
      if (updated) patch.laterOnItems = items;
      // A failed commit leaves the job pending, so it can safely retry later.
      await chrome.storage.local.set(patch);
    });
  }
  async function ensureAlarm() {
    if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.5 });
  }
  async function work() {
    // Forget ownership left by older versions without touching any user tabs.
    if ((await chrome.storage.session.get(OWNER))[OWNER]) await chrome.storage.session.remove(OWNER);
    const deadline = Date.now() + 60000;
    for (let count = 0; count < 10 && Date.now() < deadline; count++) {
      const stored = await chrome.storage.local.get([KEY, "laterOnItems"]);
      const job = stored[KEY]?.pending?.[0];
      if (!job) { await chrome.alarms.clear(ALARM); return; }
      await ensureAlarm();
      const item = (stored.laterOnItems || []).find(item => item.id === job.id && normalize(item.url) === normalize(job.url));
      const metadata = item && needsMetadata(item) ? await readMetadata(job) : null;
      await complete(job, metadata);
    }
  }
  function kick() {
    if (running) { rerun = true; return running; }
    running = Promise.resolve().then(work).catch(async () => {
      // Browser/storage failures remain retryable. Per-page network and
      // extraction failures already produce partial results and keep the URL.
      await ensureAlarm();
      await queueItemWrite(async () => {
        const state = (await chrome.storage.local.get(KEY))[KEY];
        if (state?.pending?.length) await chrome.storage.local.set({ [KEY]: { ...state, phase: "error" } });
      });
    }).catch(() => {}).finally(() => {
      running = null;
      if (rerun) { rerun = false; kick(); }
    });
    return running;
  }
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) kick(); });
  chrome.runtime.onStartup.addListener(kick);
  globalThis.LaterOnImportMetadata = { KEY, enqueue, needsMetadata, kick };
  kick();
})();

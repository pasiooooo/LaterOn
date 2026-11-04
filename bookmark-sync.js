// Native bookmarks are authoritative; this cache is device-local, never reading data.
(() => {
  const CONFIG = 'laterOnBookmarkConfig', STATE = 'laterOnBookmarkState';
  const ALARM = 'laterOnBookmarkRefresh';
  const PREVIEWS = 'laterOnBookmarkPreviewQueue', PREVIEW_ALARM = 'laterOnBookmarkPreviews';
  const PREVIEW_RETRY = 24 * 60 * 60 * 1000, PREVIEW_BATCH = 12;
  let queue = Promise.resolve(), eventPending = false, importing = false;
  let previewRunning = null, previewAgain = false;
  const installedEvents = new Map();
  const enqueue = task => {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  };
  const fail = code => { throw new Error(code); };
  const permission = () => chrome.permissions?.contains({ permissions: ['bookmarks'] }) || Promise.resolve(false);
  const readConfig = async () => (await chrome.storage.local.get(CONFIG))[CONFIG] || { enabled: false, scopeId: null };
  const readState = async () => (await chrome.storage.local.get(STATE))[STATE] || { enabled: false, nodes: [], folders: [] };
  function flatten(tree) {
    const result = [];
    const visit = (node, path, managed, rootId) => {
      const readonly = managed || !!node.unmodifiable;
      const isRoot = !node.parentId || node.parentId === rootId || !!node.folderType;
      const name = node.title || 'Bookmarks';
      const parts = node.parentId ? [...path, name] : [];
      result.push({ id: node.id, parentId: node.parentId || null, title: node.title || '',
        ...(node.url ? { url: node.url } : {}), path: parts.join(' / '),
        ...(Number.isFinite(node.dateAdded) ? { dateAdded: node.dateAdded } : {}),
        protected: readonly || isRoot, writable: !node.url && !!node.parentId && !readonly,
        ...(node.folderType ? { folderType: node.folderType } : {}) });
      for (const child of node.children || []) visit(child, parts, readonly, rootId || node.id);
    };
    for (const root of tree) visit(root, [], false, root.id);
    return result;
  }
  function inScope(node, nodes, scopeId) {
    if (!scopeId) return true;
    const visited = new Set();
    for (let current = node; current && !visited.has(current.id); current = nodes.find(entry => entry.id === current.parentId)) {
      if (current.id === scopeId) return true;
      visited.add(current.id);
    }
    return false;
  }
  async function snapshot(config, includePreviews = true) {
    const all = flatten(await chrome.bookmarks.getTree());
    const previews = includePreviews && globalThis.LaterOnBookmarkPreviews ? await LaterOnBookmarkPreviews.read(all) : {};
    const folders = all.filter(node => !node.url && node.parentId);
    const missing = config.scopeId && !folders.some(node => node.id === config.scopeId);
    return { all, state: { enabled: true, scopeId: config.scopeId || null, folders,
      nodes: missing ? [] : all.filter(node => node.parentId && inScope(node, all, config.scopeId))
        .map(node => previews[node.id]?.url === node.url ? { ...node, preview: previews[node.id] } : node),
      error: missing ? 'bookmarkScopeMissing' : null, updatedAt: Date.now() } };
  }
  async function publish(state) {
    await chrome.storage.local.set({ [STATE]: state });
    return state;
  }
  async function refreshNow() {
    const config = await readConfig();
    if (!config.enabled) {
      await chrome.storage.local.set({ [PREVIEWS]: { pending: [], attempted: {} } });
      chrome.alarms?.clear(PREVIEW_ALARM);
      return publish({ enabled: false, scopeId: config.scopeId || null, nodes: [], folders: [] });
    }
    try {
      if (!await permission()) {
        return publish({ enabled: true, scopeId: config.scopeId || null, nodes: [], folders: [], error: 'bookmarkPermission' });
      }
      registerEvents();
      const previous = (await chrome.storage.local.get(PREVIEWS))[PREVIEWS] || {};
      await globalThis.LaterOnBookmarkPreviews?.prioritize(previous.visible || []);
      const result = await snapshot(config);
      await reconcilePreviews(result.state, result.all, previous);
      return await publish(result.state);
    } catch (error) {
      try { await publish({ ...await readState(), error: 'bookmarkRefreshFailed' }); } catch {}
      throw error;
    }
  }
  const refresh = () => enqueue(refreshNow);
  async function reconcilePreviews(state, all, previous) {
    const native = new Map(all.filter(node => node.url).map(node => [node.id, node.url]));
    const attempted = Object.fromEntries(Object.entries(previous.attempted || {}).filter(([id, record]) => native.get(id) === record?.url));
    const candidates = new Map((state.error ? [] : state.nodes).filter(node => node.url &&
      globalThis.LaterOnBookmarkPreviews?.publicUrl(node.url) && (!node.preview?.image || !node.preview?.description) &&
      !(attempted[node.id]?.url === node.url && (node.preview?.sourceImage === undefined || attempted[node.id].sourceImage === node.preview.sourceImage) && Date.now() - attempted[node.id].at < PREVIEW_RETRY))
      .map(node => [node.id, { id: node.id, url: node.url }]));
    const pending = [];
    for (const job of previous.pending || []) {
      if (candidates.get(job.id)?.url !== job.url) continue;
      pending.push(candidates.get(job.id)); candidates.delete(job.id);
    }
    pending.push(...candidates.values());
    const scoped = new Map(state.nodes.filter(node => node.url).map(node => [node.id, node.url]));
    const visible = (previous.visible || []).filter(node => scoped.get(node.id) === node.url).slice(0, 144);
    await globalThis.LaterOnBookmarkPreviews?.prioritize(visible);
    await chrome.storage.local.set({ [PREVIEWS]: { scopeId: state.scopeId || null, pending, attempted, visible, visibleKey: previous.visibleKey || '' } });
    if (pending.length) chrome.alarms?.create(PREVIEW_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    else chrome.alarms?.clear(PREVIEW_ALARM);
  }
  // The durable queue contains cheap identities only. Each wake processes at
  // most twelve jobs through the global two-worker limiter; opening a view can
  // promote its covers without creating a request for every native bookmark.
  async function workPreviews() {
    let initial, jobs, generation;
    try {
      ({ initial, jobs, generation } = await enqueue(async () => {
        const initial = await context(), stored = (await chrome.storage.local.get(PREVIEWS))[PREVIEWS];
        return { initial, jobs: (stored?.pending || []).slice(0, PREVIEW_BATCH), generation: LaterOnBookmarkPreviews.epoch };
      }));
    } catch { return; }
    if (!jobs.length) return;
    const records = await LaterOnBookmarkPreviews.load(jobs, node => enqueue(async () => {
      const latest = await context(false);
      if (latest.node(node.id).url !== node.url || generation !== LaterOnBookmarkPreviews.epoch) fail('bookmarkPreviewUnavailable');
    }));
    await enqueue(async () => {
      let latest;
      try { latest = await context(); } catch { return; }
      if (generation !== LaterOnBookmarkPreviews.epoch || latest.config.scopeId !== initial.config.scopeId) return;
      const valid = records.filter(record => latest.all.some(node => node.id === record.id && node.url === record.url && inScope(node, latest.all, latest.config.scopeId)));
      await LaterOnBookmarkPreviews.commit(valid, latest.all, generation);
      const stored = (await chrome.storage.local.get(PREVIEWS))[PREVIEWS] || {};
      const attempted = { ...(stored.attempted || {}) };
      const previews = (await chrome.storage.local.get('laterOnBookmarkPreviews')).laterOnBookmarkPreviews || {};
      for (const job of jobs) {
        const record = valid.find(record => record.id === job.id), cached = previews[job.id];
        attempted[job.id] = { url: job.url, at: Date.now(), sourceImage: record?.sourceImage || cached?.sourceImage || '',
          complete: !!record && !record.error && !!(record.image || cached?.image) && !!(record.description || cached?.description) };
      }
      await chrome.storage.local.set({ [PREVIEWS]: { ...stored, attempted,
        pending: (stored.pending || []).filter(job => !jobs.some(done => done.id === job.id && done.url === job.url)) } });
      await refreshNow();
    });
  }
  function kickPreviews() {
    if (previewRunning) { previewAgain = true; return previewRunning; }
    previewRunning = workPreviews().catch(() => {}).finally(() => {
      previewRunning = null;
      if (previewAgain) { previewAgain = false; kickPreviews(); }
    });
    return previewRunning;
  }
  async function prioritizePreviews(message) {
    if (!Array.isArray(message.ids) || message.ids.some(id => typeof id !== 'string')) fail('bookmarkInvalidItems');
    const state = await enqueue(async () => {
      const latest = await context();
      const stored = (await chrome.storage.local.get(PREVIEWS))[PREVIEWS] || {};
      const visible = [];
      for (const id of new Set(message.ids.slice(0, 144))) {
        try { const node = latest.node(id); if (node.url) visible.push({ id, url: node.url }); } catch {}
      }
      const ids = new Set(visible.map(node => node.id));
      const visibleKey = typeof message.viewKey === 'string' ? message.viewKey.slice(0, 20000) : JSON.stringify([...ids]);
      const attempted = { ...(stored.attempted || {}) }, pending = [...stored.pending || []];
      const previews = (await chrome.storage.local.get('laterOnBookmarkPreviews')).laterOnBookmarkPreviews || {};
      // A new view may restore an evicted successful cover immediately. A
      // same-view redraw cannot restart it repeatedly when the byte budget is
      // too small to retain every visible image. Failed jobs keep their cooldown.
      if (stored.visibleKey !== visibleKey) for (const node of visible) {
        const attempt = attempted[node.id];
        if (attempt?.url !== node.url || !attempt.complete || previews[node.id]?.image || !LaterOnBookmarkPreviews.publicUrl(node.url)) continue;
        delete attempted[node.id];
        if (!pending.some(job => job.id === node.id && job.url === node.url)) pending.push(node);
      }
      await LaterOnBookmarkPreviews.prioritize(visible);
      await chrome.storage.local.set({ [PREVIEWS]: { ...stored, attempted, visible, visibleKey,
        pending: [...pending.filter(job => ids.has(job.id)), ...pending.filter(job => !ids.has(job.id))] } });
      return readState();
    });
    kickPreviews();
    return state;
  }
  async function context(includePreviews = true) {
    const config = await readConfig();
    if (!config.enabled) fail('bookmarkDisabled');
    if (!await permission()) fail('bookmarkPermission');
    const { all, state } = await snapshot(config, includePreviews);
    if (state.error) fail(state.error);
    const node = id => {
      const result = all.find(entry => entry.id === id);
      if (!result || !inScope(result, all, config.scopeId)) fail('bookmarkOutOfScope');
      return result;
    };
    const folder = id => {
      const result = node(id);
      if (result.url) fail('bookmarkFolderRequired');
      if (!result.writable) fail('bookmarkProtected');
      return result;
    };
    const editable = id => {
      const result = node(id);
      if (result.protected || result.id === config.scopeId) fail('bookmarkProtected');
      return result;
    };
    return { config, all, node, folder, editable };
  }
  const title = value => {
    if (typeof value !== 'string' || !value.trim()) fail('bookmarkTitleRequired');
    return value.trim();
  };
  const safeUrl = value => {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {}
    return fail('bookmarkInvalidUrl');
  };
  async function afterCommit(extra = {}) {
    try { return { ...await refreshNow(), ...extra, committed: true }; }
    catch { return { ...await readState().catch(() => ({ nodes: [], folders: [] })), enabled: true, error: 'bookmarkRefreshFailed', ...extra, committed: true }; }
  }
  async function execute(message) {
    if (message.type === 'BOOKMARKS_GET') return refreshNow();
    if (message.type === 'BOOKMARKS_CONFIG') {
      const current = await readConfig();
      const config = { enabled: message.enabled === true, scopeId: message.scopeId === undefined ? current.scopeId || null : message.scopeId || null };
      if (config.enabled) {
        if (!await permission()) fail('bookmarkPermission');
        registerEvents();
        const folders = flatten(await chrome.bookmarks.getTree()).filter(node => !node.url && node.parentId);
        if (config.scopeId && !folders.some(node => node.id === config.scopeId)) fail('bookmarkFolderRequired');
      }
      if (current.enabled !== config.enabled || current.scopeId !== config.scopeId) globalThis.LaterOnBookmarkPreviews?.cancel();
      await chrome.storage.local.set({ [CONFIG]: config });
      if (config.enabled) chrome.alarms?.create(ALARM, { periodInMinutes: 5 });
      else chrome.alarms?.clear(ALARM);
      return refreshNow();
    }
    const ctx = await context();
    if (message.type === 'BOOKMARKS_CREATE') {
      ctx.folder(message.parentId);
      const data = { parentId: message.parentId, title: title(message.title) };
      if (message.url !== undefined) data.url = safeUrl(message.url);
      await chrome.bookmarks.create(data);
    } else if (message.type === 'BOOKMARKS_UPDATE') {
      const target = ctx.editable(message.id);
      const patch = {};
      if (message.title !== undefined) patch.title = title(message.title);
      if (message.url !== undefined) {
        if (!target.url) fail('bookmarkFolderRequired');
        patch.url = safeUrl(message.url);
      }
      if (!Object.keys(patch).length) fail('bookmarkTitleRequired');
      await chrome.bookmarks.update(target.id, patch);
    } else if (message.type === 'BOOKMARKS_MOVE') {
      const target = ctx.editable(message.id), parent = ctx.folder(message.parentId);
      if (inScope(parent, ctx.all, target.id)) fail('bookmarkInvalidMove');
      await chrome.bookmarks.move(target.id, { parentId: parent.id });
    } else if (message.type === 'BOOKMARKS_REMOVE') {
      const target = ctx.editable(message.id);
      if (!target.url && ctx.all.some(node => node.parentId === target.id)) fail('bookmarkNotEmpty');
      await chrome.bookmarks.remove(target.id);
    } else if (message.type === 'BOOKMARKS_COPY_ITEMS') {
      ctx.folder(message.parentId);
      if (!Array.isArray(message.ids) || !message.ids.length || message.ids.some(id => typeof id !== 'string')) fail('bookmarkInvalidItems');
      const stored = await chrome.storage.local.get('laterOnItems');
      const results = { added: 0, existing: 0, failed: [], successfulIds: [] };
      // Native multi-item creation is not atomic; report partial success and dedupe retries.
      for (const id of new Set(message.ids)) {
        try {
          const item = (stored.laterOnItems || []).find(entry => entry.id === id);
          if (!item) fail('bookmarkItemMissing');
          const url = safeUrl(item.url);
          // The browser can move/delete a destination while a transfer is running.
          const latest = await context();
          latest.folder(message.parentId);
          if (latest.all.some(node => node.parentId === message.parentId && node.url === url)) results.existing++;
          else { await chrome.bookmarks.create({ parentId: message.parentId, title: item.title || url, url }); results.added++; }
          results.successfulIds.push(id);
        } catch (error) { results.failed.push({ id, title: (stored.laterOnItems || []).find(item => item.id === id)?.title || id, error: error.message }); }
      }
      return afterCommit({ results });
    } else fail('bookmarkInvalidAction');
    return afterCommit();
  }
  async function loadPreviews(message) {
    const previews = globalThis.LaterOnBookmarkPreviews;
    if (!previews || !Array.isArray(message.ids) || message.ids.some(id => typeof id !== 'string')) fail('bookmarkInvalidItems');
    const initial = await enqueue(context), generation = previews.epoch;
    const nodes = [...new Set(message.ids)].slice(0, 12).map(id => initial.node(id)).filter(node => node.url);
    const records = await previews.load(nodes, node => enqueue(async () => {
      const latest = await context(false), current = latest.node(node.id);
      if (current.url !== node.url || generation !== previews.epoch) fail('bookmarkPreviewUnavailable');
    }));
    return enqueue(async () => {
      let latest;
      try { latest = await context(); } catch {
        return { ...await refreshNow(), previewResults: { updated: 0, failed: nodes.length, cancelled: true } };
      }
      if (generation !== previews.epoch || latest.config.scopeId !== initial.config.scopeId) {
        return { ...await refreshNow(), previewResults: { updated: 0, failed: nodes.length, cancelled: true } };
      }
      const valid = records.filter(record => latest.all.some(node => node.id === record.id && node.url === record.url && inScope(node, latest.all, latest.config.scopeId)));
      await previews.commit(valid, latest.all, generation);
      return { ...await refreshNow(), previewResults: { updated: valid.filter(record => !record.error && (record.image || record.description)).length,
        failed: nodes.length - valid.filter(record => !record.error && (record.image || record.description)).length } };
    });
  }
  const handle = message => message.type === 'BOOKMARKS_PREVIEWS'
    ? message.automatic ? prioritizePreviews(message) : loadPreviews(message) : enqueue(() => execute(message));
  function onNativeChange() {
    if (eventPending || importing) return;
    eventPending = true;
    enqueue(async () => { eventPending = false; return refreshNow(); }).catch(() => {});
  }
  function registerEvents() {
    if (!chrome.bookmarks) return;
    for (const [name, handler] of Object.entries(nativeHandlers)) {
      const event = chrome.bookmarks[name];
      if (!event?.addListener) continue;
      try {
        if (event.hasListener ? event.hasListener(handler) : installedEvents.get(name) === event) continue;
        event.addListener(handler);
        installedEvents.set(name, event);
      } catch { /* Optional APIs can exist before their permission is granted. */ }
    }
  }
  const nativeHandlers = Object.fromEntries(['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered'].map(name => [name, onNativeChange]));
  nativeHandlers.onImportBegan = () => { importing = true; };
  nativeHandlers.onImportEnded = () => { importing = false; onNativeChange(); };
  // Wake-up listeners must be registered synchronously, including after worker restarts.
  registerEvents();
  chrome.permissions?.onAdded?.addListener(() => { registerEvents(); refresh().catch(() => {}); });
  chrome.permissions?.onRemoved?.addListener(() => {
    globalThis.LaterOnBookmarkPreviews?.cancel();
    for (const [name, handler] of Object.entries(nativeHandlers)) {
      try { chrome.bookmarks?.[name]?.removeListener?.(handler); } catch {}
    }
    installedEvents.clear(); importing = false;
    refresh().catch(() => {});
  });
  chrome.runtime.onStartup?.addListener(() => { refresh().catch(() => {}); });
  chrome.runtime.onInstalled?.addListener(() => { refresh().catch(() => {}); });
  chrome.alarms?.onAlarm?.addListener(alarm => {
    if (alarm.name === ALARM) refresh().catch(() => {});
    if (alarm.name === PREVIEW_ALARM) kickPreviews();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith('BOOKMARKS_')) return;
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) { respond({ ok: false, error: 'bookmarkPermission' }); return; }
    handle(message).then(state => respond({ ok: true, state }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  globalThis.LaterOnBookmarkSync = { handle, refresh };
  refresh().catch(() => {});
})();

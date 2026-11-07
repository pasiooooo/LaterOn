// Native bookmarks are authoritative; this cache is device-local, never reading data.
(() => {
  const CONFIG = 'laterOnBookmarkConfig', STATE = 'laterOnBookmarkState';
  const META = 'laterOnBookmarkStateMeta', SEARCH = 'laterOnBookmarkSearchState';
  const ALARM = 'laterOnBookmarkRefresh';
  const PREVIEWS = 'laterOnBookmarkPreviewQueue', PREVIEW_ALARM = 'laterOnBookmarkPreviews';
  const VISIBLE = 'laterOnBookmarkPreviewVisible';
  const PREVIEW_RETRY = 24 * 60 * 60 * 1000, PREVIEW_BATCH = 12;
  const RECHECK = 60 * 1000;
  let queue = Promise.resolve(), eventPending = false, importing = false;
  let previewRunning = null, previewAgain = false;
  let meta = null, metaLoaded = false, indexChecked = false, membershipCache = null;
  let latestNativeChange = 0;
  let sourceCache = null, sourceSignature = '', leanCache = null, recoveryTimer = null, recovering = false, viewActiveUntil = 0;
  let queueMemo = null, previewTimer = null;
  let urgentRequests = 0, legacyCleanupTimer = null, legacyCleaned = false;
  const interactive = () => Date.now() < viewActiveUntil || globalThis.LaterOnQuickSwitcher?.isInteractive?.() === true;
  const idleTurn = () => new Promise(resolve => setTimeout(resolve, 50));
  async function waitForIdle(serialized = false, isCurrent) {
    while (interactive() && !(serialized && urgentRequests)) {
      if (isCurrent && !isCurrent()) throw Error('staleLocalIndex');
      await idleTurn();
    }
    if (isCurrent && !isCurrent()) throw Error('staleLocalIndex');
  }
  const yieldWork = async (urgent = false, serialized = false, isCurrent) => {
    if (!urgent) await waitForIdle(serialized, isCurrent);
    return globalThis.LaterOnQuickSearch?.yieldTask?.() || new Promise(resolve => setTimeout(resolve, 0));
  };
  async function readQueue() {
    if (sourceIndex() && queueMemo) return queueMemo;
    const next = (await chrome.storage.local.get(PREVIEWS))[PREVIEWS] || {};
    if (sourceIndex()) queueMemo = next;
    return next;
  }
  async function writeQueue(next, urgent = false) {
    if (sourceIndex() && !urgent) await waitForIdle(true);
    await chrome.storage.local.set({ [PREVIEWS]: next });
    if (sourceIndex()) queueMemo = next;
  }
  const installedEvents = new Map();
  const enqueue = task => {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  };
  // A foreground native action must also release a background task that is
  // already paused inside the shared queue, otherwise its urgent refresh
  // would still sit behind an unrelated dialog's activity lease.
  const enqueueUrgent = task => {
    urgentRequests++;
    return enqueue(task).finally(() => { urgentRequests--; });
  };
  const fail = code => { throw new Error(code); };
  const permission = () => chrome.permissions?.contains({ permissions: ['bookmarks'] }) || Promise.resolve(false);
  const readConfig = async () => (await chrome.storage.local.get(CONFIG))[CONFIG] || { enabled: false, scopeId: null };
  const readState = async () => sourceIndex()
    ? sourceCache || await indexApi().bookmarkSearchSource() || { enabled: false, nodes: [], folders: [] }
    : (await chrome.storage.local.get(STATE))[STATE] || { enabled: false, nodes: [], folders: [] };
  async function readMeta() {
    if (!metaLoaded) {
      try { meta = (await chrome.storage.local.get(META))[META] || null; } catch { meta = null; }
      metaLoaded = true;
    }
    return meta;
  }
  // Flatten once and mark the selected scope while walking down the tree, so
  // scope membership never needs an ancestor search per bookmark.
  function flatten(tree, scopeId = null) {
    const result = [], scoped = new Set();
    const visit = (node, path, managed, rootId, inside) => {
      const readonly = managed || !!node.unmodifiable;
      const isRoot = !node.parentId || node.parentId === rootId || !!node.folderType;
      const name = node.title || 'Bookmarks';
      const parts = node.parentId ? [...path, name] : [];
      const within = !scopeId || inside || node.id === scopeId;
      if (within) scoped.add(node.id);
      result.push({ id: node.id, parentId: node.parentId || null, title: node.title || '',
        ...(node.url ? { url: node.url } : {}), path: parts.join(' / '),
        ...(Number.isFinite(node.dateAdded) ? { dateAdded: node.dateAdded } : {}),
        protected: readonly || isRoot, writable: !node.url && !!node.parentId && !readonly,
        ...(node.folderType ? { folderType: node.folderType } : {}) });
      for (const child of node.children || []) visit(child, parts, readonly, rootId || node.id, within);
    };
    for (const root of tree) visit(root, [], false, root.id, false);
    Object.defineProperty(result, 'scoped', { value: scoped });
    return result;
  }
  const byIdOf = nodes => nodes.byId || Object.defineProperty(nodes, 'byId', { value: new Map(nodes.map(node => [node.id, node])) }).byId;
  function inScope(node, nodes, scopeId) {
    if (!scopeId) return true;
    const byId = byIdOf(nodes);
    const visited = new Set();
    for (let current = node; current && !visited.has(current.id); current = byId.get(current.parentId)) {
      if (current.id === scopeId) return true;
      visited.add(current.id);
    }
    return false;
  }
  const scopedIn = (nodes, scopeId, node) => !scopeId || (nodes.scoped ? nodes.scoped.has(node.id) : inScope(node, nodes, scopeId));
  async function snapshot(config, includePreviews = true) {
    const all = flatten(await chrome.bookmarks.getTree(), config.scopeId || null);
    const previews = includePreviews && globalThis.LaterOnBookmarkPreviews ? await LaterOnBookmarkPreviews.read(all) : {};
    const folders = all.filter(node => !node.url && node.parentId);
    const missing = config.scopeId && !folders.some(node => node.id === config.scopeId);
    return { all, state: { enabled: true, scopeId: config.scopeId || null, folders,
      nodes: missing ? [] : all.filter(node => node.parentId && scopedIn(all, config.scopeId, node))
        .map(node => previews[node.id]?.url === node.url ? { ...node, preview: previews[node.id] } : node),
      error: missing ? 'bookmarkScopeMissing' : null, updatedAt: Date.now() } };
  }
  // A cheap, stable content digest. Preview bytes are represented by their
  // update times, so an unchanged mirror is recognised without hashing images.
  function digest() {
    let first = 0x811c9dc5, second = 0x01000193, length = 0;
    const multiply = Math.imul;
    const add = value => {
      const text = value === undefined || value === null ? '\u0000' : String(value);
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        first = multiply(first ^ code, 0x01000193);
        second = multiply(second ^ code, 0x5bd1e995) ^ (second >>> 13);
      }
      first = multiply(first ^ 31, 0x01000193); second = multiply(second ^ 31, 0x5bd1e995);
      length += text.length + 1;
    };
    return { add, value: () => `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}-${length.toString(36)}` };
  }
  const NODE_FIELDS = ['id', 'parentId', 'title', 'url', 'path', 'dateAdded', 'protected', 'writable', 'folderType'];
  async function signatures(state, urgent = false) {
    const lean = digest(), full = digest();
    for (const value of [state.enabled === true, state.error || '', state.scopeId || '']) { lean.add(value); full.add(value); }
    for (const [label, list] of [['f', state.folders], ['n', state.nodes]]) {
      lean.add(label); full.add(label);
      let work = 0;
      for (const node of Array.isArray(list) ? list : []) {
        if (++work % 250 === 0) await yieldWork(urgent, true);
        for (const field of NODE_FIELDS) { lean.add(node?.[field]); full.add(node?.[field]); }
        const preview = label === 'n' ? node?.preview : null;
        if (preview) for (const value of [preview.url, preview.updatedAt, preview.attemptedAt, preview.failed]) full.add(value);
        else full.add('');
      }
    }
    return { signature: full.value(), leanSignature: lean.value() };
  }
  const strip = node => {
    const { preview, ...lean } = node;
    return lean;
  };
  function searchState(state) {
    return { enabled: state.enabled === true, scopeId: state.scopeId || null, error: state.error || null,
      updatedAt: state.updatedAt, folders: (state.folders || []).map(strip), nodes: (state.nodes || []).map(strip) };
  }
  // Device-local index synchronisation. One job runs at a time; a newer full
  // build supersedes queued work and cancels an in-progress older build, and
  // consecutive preview patches merge. Revisions (updatedAt) are monotonic.
  const indexApi = () => {
    const local = globalThis.LaterOnLocalIndex;
    try { return local?.supported?.() && local.putBookmarkState && local.patchBookmarkPreviews ? local : null; } catch { return null; }
  };
  const sourceIndex = () => typeof indexApi()?.bookmarkSearchSource === 'function';
  let indexJobs = [], indexRunning = null, indexReady = null, indexFull = 0, retryTimer = null, retryDelay = 2000;
  const revision = previous => Math.max(Date.now(), (Number(previous?.updatedAt) || 0) + 1);
  const notify = updatedAt => {
    globalThis.LaterOnQuickSwitcher?.bookmarksReady?.(updatedAt);
    try { chrome.runtime.sendMessage?.({ type: 'BOOKMARKS_CHANGED', updatedAt })?.catch?.(() => {}); } catch {}
  };
  function queueIndex(job) {
    if (!indexApi()) return Promise.resolve();
    if (job.kind === 'full') { job.serial = ++indexFull; indexJobs = [job]; }
    else {
      const last = indexJobs[indexJobs.length - 1];
      if (last?.kind === 'patch' && last.scopeId === job.scopeId) {
        const merged = new Map([...last.records.map(item => [item.id, item]), ...last.removedIds.map(id => [id, null])]);
        for (const id of job.removedIds) merged.set(id, null);
        for (const item of job.records) merged.set(item.id, item);
        last.records = [...merged.values()].filter(Boolean);
        last.removedIds = [...merged].filter(([, value]) => !value).map(([id]) => id);
        last.updatedAt = job.updatedAt; last.signature = job.signature;
      } else indexJobs.push(job);
    }
    if (!indexRunning) indexRunning = drainIndex().finally(() => { indexRunning = null; });
    return indexRunning;
  }
  function failIndex() {
    indexChecked = false; indexReady = null;
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; recoverIndex().catch(() => {}); }, retryDelay);
    retryTimer.unref?.();
    retryDelay = Math.min(retryDelay * 2, 60000);
  }
  async function drainIndex() {
    while (indexJobs.length) {
      await waitForIdle();
      const job = indexJobs.shift(), local = indexApi();
      if (!local) return;
      try {
        if (job.kind === 'full') {
          const result = await local.putBookmarkState(job.state, { signature: job.signature, isCurrent: () => job.serial === indexFull && !interactive() });
          if (result && result.stale) continue;
          if (!result) { failIndex(); continue; }
          indexReady = { updatedAt: job.state.updatedAt, scopeId: job.state.scopeId || null };
        } else {
          if (indexJobs.some(next => next.kind === 'full')) continue;
          const result = await local.patchBookmarkPreviews({ records: job.records, removedIds: job.removedIds },
            { updatedAt: job.updatedAt, baseUpdatedAt: job.baseUpdatedAt, signature: job.signature, scopeId: job.scopeId });
          if (result && result.stale) continue;
          if (!result) { if (!indexJobs.some(next => next.kind === 'full')) await rebuildIndex(); continue; }
          indexReady = { updatedAt: job.updatedAt, scopeId: job.scopeId };
        }
        indexChecked = true; retryDelay = 2000;
        notify(indexReady.updatedAt);
        scheduleLegacyCleanup();
      } catch (error) {
        if (error?.message === 'staleLocalIndex') {
          if ((job.kind !== 'full' || job.serial === indexFull) && !indexJobs.some(next => next.kind === 'full')) indexJobs.unshift(job);
          continue;
        }
        failIndex();
      }
    }
  }
  // A full build from the persisted mirror plus the current preview cache;
  // previews may be newer than the stored mirror when they were patched.
  async function rebuildIndex() {
    if (sourceIndex()) {
      const info = await readMeta();
      if (sourceCache && info && sourceCache.updatedAt === info.updatedAt) queueIndex({ kind: 'full', state: sourceCache, signature: info.signature });
      else scheduleRecovery();
      return;
    }
    const stored = await chrome.storage.local.get([STATE, META, 'laterOnBookmarkPreviews']);
    const state = stored[STATE], info = stored[META];
    if (!state || !info || !state.enabled || state.error) return;
    const previews = stored.laterOnBookmarkPreviews || {};
    const nodes = (state.nodes || []).map(node => {
      if (!node.url) return node;
      const { preview, ...plain } = node;
      return previews[node.id]?.url === node.url ? { ...plain, preview: previews[node.id] } : plain;
    });
    queueIndex({ kind: 'full', state: { ...state, nodes, updatedAt: info.updatedAt }, signature: info.signature });
  }
  async function recoverIndex() {
    const info = await readMeta();
    if (info) await ensureIndex(null, info);
  }
  // First paint and active queries have priority over any large source read.
  // Native bookmarks remain available through bounded APIs while we wait.
  function scheduleRecovery() {
    if (recoveryTimer || recovering || indexRunning || indexJobs.length) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      recovering = true;
      (async () => { await waitForIdle(); return enqueue(refreshNow); })().catch(() => {}).finally(() => { recovering = false; });
    }, 1200);
    recoveryTimer.unref?.();
  }
  // Both Chrome mirrors are derived caches. Once their replacement is
  // durably published, remove them during a quiet turn; removal can itself
  // carry large oldValue payloads to listeners, so it never runs on invoke.
  function scheduleLegacyCleanup() {
    if (!sourceIndex() || legacyCleaned || legacyCleanupTimer || !chrome.storage.local.remove) return;
    legacyCleanupTimer = setTimeout(() => {
      legacyCleanupTimer = null;
      (async () => {
        await waitForIdle();
        const [current, published] = await Promise.all([readMeta(), indexApi().info('bookmarks')]);
        if (current?.source !== 'indexeddb' || !published?.ready || !published.searchSourceReady
          || published.updatedAt !== current.updatedAt || (published.scopeId || null) !== (current.scopeId || null)) return;
        await waitForIdle();
        await chrome.storage.local.remove([STATE, SEARCH]);
        legacyCleaned = true;
      })().catch(() => {});
    }, 30000);
    legacyCleanupTimer.unref?.();
  }
  // Verifies once per worker (and again after any failure) that the index
  // holds the published revision; only a missing or older index is rebuilt.
  async function ensureIndex(state, current) {
    const local = indexApi();
    if (!local || !current?.enabled || current.error) return;
    if (indexChecked && indexReady?.updatedAt === current.updatedAt) return;
    if (indexRunning || indexJobs.length) return;
    indexChecked = true;
    let info = null;
    try { info = await local.info?.('bookmarks'); } catch { failIndex(); return; }
    if (info?.ready && (!sourceIndex() || info.searchSourceReady === true) && Number(info.updatedAt) === Number(current.updatedAt) && (info.scopeId || null) === (current.scopeId || null)) {
      indexReady = { updatedAt: current.updatedAt, scopeId: current.scopeId || null };
      scheduleLegacyCleanup();
      return;
    }
    if (info?.ready && Number(info.updatedAt) > Number(current.updatedAt)) return;
    if (state) queueIndex({ kind: 'full', state: { ...state, updatedAt: current.updatedAt }, signature: current.signature });
    else await rebuildIndex();
  }
  async function writeMeta(next) {
    await chrome.storage.local.set({ [META]: next });
    meta = next; metaLoaded = true;
  }
  // Preview-only change with a device-local index: patch the affected pages
  // and record a new revision in the tiny meta record. The large mirror is not
  // rewritten or broadcast. Without the index the full mirror is published.
  async function publishPreviews(changes, previous, signature) {
    const at = changes.records.length || changes.removedIds.length ? revision(previous) : previous.updatedAt;
    const next = { ...previous, updatedAt: at, signature: signature || `${previous.leanSignature}:p${at}`, checkedAt: Date.now() };
    await writeMeta(next);
    if (at !== previous.updatedAt) queueIndex({ kind: 'patch', records: changes.records, removedIds: changes.removedIds,
      updatedAt: at, baseUpdatedAt: previous.updatedAt, signature: next.signature, scopeId: previous.scopeId || null });
    return next;
  }
  async function publish(state, nativeVerifiedAt = 0, urgent = false) {
    const previous = await readMeta(), now = Date.now();
    const { signature, leanSignature } = await signatures(state, urgent);
    sourceSignature = leanSignature;
    const verified = { ...(nativeVerifiedAt ? { nativeVerifiedAt: Math.max(Number(previous?.nativeVerifiedAt) || 0, nativeVerifiedAt) } : {}),
      ...(sourceIndex() ? { source: 'indexeddb' } : {}) };
    const changes = globalThis.LaterOnBookmarkPreviews?.takeChanges?.() || { records: [], removedIds: [] };
    if (previous?.signature === signature) {
      const unchanged = { ...state, updatedAt: previous.updatedAt };
      sourceCache = unchanged;
      if (nativeVerifiedAt || now - (previous.checkedAt || 0) > RECHECK) await writeMeta({ ...previous, ...verified, checkedAt: now });
      ensureIndex(unchanged, meta).catch(() => {});
      return unchanged;
    }
    if (previous && previous.leanSignature === leanSignature && state.enabled && !state.error && indexApi()) {
      const next = await publishPreviews(changes, previous, signature);
      if (nativeVerifiedAt) await writeMeta({ ...next, ...verified });
      sourceCache = { ...state, updatedAt: next.updatedAt };
      if (next.updatedAt === previous.updatedAt) ensureIndex({ ...state, updatedAt: next.updatedAt }, next).catch(() => {});
      return { ...state, updatedAt: next.updatedAt };
    }
    const updatedAt = revision(previous);
    state = { ...state, updatedAt };
    sourceCache = state; leanCache = null;
    const next = { signature, leanSignature, updatedAt, checkedAt: now, ...verified,
      enabled: state.enabled === true, scopeId: state.scopeId || null, error: state.error || null,
      pages: (state.nodes || []).filter(node => node.url).length, ...(sourceIndex() ? { source: 'indexeddb' } : {}) };
    // A native update publishes only small metadata. The full state and lean
    // search source live in generation-tagged IndexedDB rows; broadcasting
    // two 50k-node JSON mirrors used to block every extension listener.
    const patch = sourceIndex() ? { [META]: next } : { [STATE]: state, [META]: next };
    const leanChanged = previous?.leanSignature !== leanSignature;
    if (leanChanged && !sourceIndex()) patch[SEARCH] = searchState(state);
    await chrome.storage.local.set(patch);
    meta = next; metaLoaded = true;
    if (leanChanged) membershipCache = null;
    queueIndex({ kind: 'full', state, signature }).catch(() => {});
    return state;
  }
  // Search source reads stay in this worker or use bounded, image-free IDB
  // blocks. No service-worker restart needs to deserialize the large mirror.
  async function searchSource({ isCurrent, urgent = false } = {}) {
    const [info, config] = await Promise.all([readMeta(), readConfig()]);
    if (!config.enabled) return { enabled: false, scopeId: config.scopeId || null, error: null, nodes: [], folders: [] };
    // Missing metadata is the normal first-upgrade state, not proof that the
    // user's bookmarks are disabled. The old scope is equally unusable.
    if (!info?.enabled || (info.scopeId || null) !== (config.scopeId || null)) { scheduleRecovery(); return null; }
    if (info.error) { scheduleRecovery(); return { enabled: true, scopeId: config.scopeId || null, error: info.error, nodes: [], folders: [] }; }
    if (isCurrent && !isCurrent()) throw Error('staleLocalIndex');
    if (leanCache?.signature === info.leanSignature) return { ...leanCache.state, updatedAt: info.updatedAt };
    if (sourceCache && sourceSignature === info.leanSignature) {
      const before = sourceCache, folders = [], nodes = [];
      let work = 0;
      for (const [list, target] of [[before.folders || [], folders], [before.nodes || [], nodes]]) for (const node of list) {
        if (++work % 250 === 0) { await yieldWork(urgent, false, isCurrent); if (isCurrent && !isCurrent()) throw Error('staleLocalIndex'); }
        target.push(strip(node));
      }
      if (before !== sourceCache) throw Error('staleLocalIndex');
      leanCache = { signature: info.leanSignature, state: { enabled: before.enabled, scopeId: before.scopeId || null, error: before.error || null, folders, nodes } };
      return { ...leanCache.state, updatedAt: info.updatedAt };
    }
    if (sourceIndex()) {
      const source = await indexApi().bookmarkSearchSource({ updatedAt: info.updatedAt, isCurrent });
      if (!source) { scheduleRecovery(); return null; }
      sourceCache = source; sourceSignature = info.leanSignature;
      leanCache = { signature: info.leanSignature, state: source };
      return source;
    }
    const stored = await chrome.storage.local.get(SEARCH);
    return stored[SEARCH] || await readState();
  }
  async function refreshNow({ urgent = false } = {}) {
    if (sourceIndex() && !urgent) await waitForIdle(true);
    const config = await readConfig();
    if (!config.enabled) {
      const queued = await readQueue();
      if (!same(queued, { pending: [], attempted: {} })) await writeQueue({ pending: [], attempted: {} }, urgent);
      chrome.alarms?.clear(PREVIEW_ALARM);
      return publish({ enabled: false, scopeId: config.scopeId || null, nodes: [], folders: [] }, 0, urgent);
    }
    try {
      if (!await permission()) {
        return publish({ enabled: true, scopeId: config.scopeId || null, nodes: [], folders: [], error: 'bookmarkPermission' }, 0, urgent);
      }
      registerEvents();
      const previous = await readQueue();
      await globalThis.LaterOnBookmarkPreviews?.prioritize(previous.visible || []);
      const verifiedAt = Date.now();
      const result = await snapshot(config);
      await reconcilePreviews(result.state, result.all, previous, urgent);
      return await publish(result.state, verifiedAt, urgent);
    } catch (error) {
      try { await publish({ ...await readState(), error: 'bookmarkRefreshFailed' }, 0, urgent); } catch {}
      throw error;
    }
  }
  const refresh = () => enqueueUrgent(() => refreshNow({ urgent: true }));
  function same(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) if (!Object.prototype.hasOwnProperty.call(b, key) || !same(a[key], b[key])) return false;
    return true;
  }
  async function reconcilePreviews(state, all, previous, urgent = false) {
    if (sourceIndex() || all.length > 250) await yieldWork(urgent, true);
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
    const next = { scopeId: state.scopeId || null, pending, attempted, visible, visibleKey: previous.visibleKey || '' };
    if (!same(next, previous)) await writeQueue(next, urgent);
    if (pending.length) chrome.alarms?.create(PREVIEW_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    else chrome.alarms?.clear(PREVIEW_ALARM);
  }
  // The durable queue contains cheap identities only. Each wake processes at
  // most twelve jobs through the global two-worker limiter; opening a view can
  // promote its covers without creating a request for every native bookmark.
  // Bounded live checks for a handful of visible or queued pages: the native
  // node, its URL and its scope ancestry are read for those ids only, so
  // opening or redrawing a view never walks or copies the whole tree.
  async function liveNodes(ids, config, { includeFolders = false, strict = false } = {}) {
    const unique = [...new Set(ids)].slice(0, 144), found = new Map();
    if (!unique.length) return found;
    if (typeof chrome.bookmarks?.get !== 'function') {
      const ctx = await context(false);
      for (const id of unique) {
        try { const node = ctx.node(id); if (includeFolders || node.url) found.set(id, node); }
        catch (error) { if (strict) throw error; }
      }
      return found;
    }
    let nodes;
    try { nodes = await chrome.bookmarks.get(unique); }
    catch { nodes = await Promise.all(unique.map(id => chrome.bookmarks.get(id).then(list => list?.[0], () => null))); }
    const memo = new Map(), byId = new Map((nodes || []).filter(Boolean).map(node => [node.id, node]));
    for (const id of unique) {
      const node = byId.get(id);
      if (!node || !await withinScope(node, config.scopeId || null, memo)) { if (strict) fail('bookmarkOutOfScope'); continue; }
      if (includeFolders || node.url) found.set(id, node);
    }
    return found;
  }
  async function withinScope(node, scopeId, memo) {
    if (!scopeId) return true;
    const chain = [];
    let inside = false;
    for (let current = node, seen = new Set(); current && !seen.has(current.id); ) {
      if (current.id === scopeId) { inside = true; break; }
      if (memo.has(current.id)) { inside = memo.get(current.id); break; }
      seen.add(current.id); chain.push(current.id);
      if (!current.parentId) break;
      try { current = (await chrome.bookmarks.get(current.parentId))?.[0]; } catch { break; }
    }
    for (const id of chain) memo.set(id, inside);
    return inside;
  }
  async function liveConfig() {
    const config = await readConfig();
    if (!config.enabled) fail('bookmarkDisabled');
    if (!await permission()) fail('bookmarkPermission');
    return config;
  }
  // The durable queue contains cheap identities only. Each wake processes at
  // most twelve jobs through the global two-worker limiter. An empty queue
  // returns before any native read; queued jobs are checked one by one, and
  // the complete tree is read once per batch only to commit and prune.
  async function workPreviews() {
    let config, jobs, generation;
    try {
      ({ config, jobs, generation } = await enqueue(async () => {
        if (sourceIndex()) await waitForIdle(true);
        let stored = await readQueue();
        if (sourceIndex()) {
          const announced = (await chrome.storage.local.get(VISIBLE))[VISIBLE];
          const live = announced ? await liveConfig() : null;
          if (announced && (announced.scopeId || null) === (live.scopeId || null)) {
            const native = await liveNodes((announced.visible || []).map(node => node.id), live);
            const visible = (announced.visible || []).filter(node => native.get(node.id)?.url === node.url);
            const previousKey = stored.visibleKey;
            stored = await updatePriority(visible, announced.visibleKey || '', { ...stored, visibleKey: announced.processedKey || previousKey }, true);
            queueMemo = stored;
            const latest = (await chrome.storage.local.get(VISIBLE))[VISIBLE];
            if (latest?.visibleKey === announced.visibleKey && (latest.scopeId || null) === (announced.scopeId || null))
              await chrome.storage.local.set({ [VISIBLE]: { ...latest, processedKey: announced.visibleKey } });
          }
        }
        const jobs = (stored?.pending || []).slice(0, PREVIEW_BATCH);
        if (!jobs.length) return { jobs };
        return { config: await liveConfig(), jobs, generation: LaterOnBookmarkPreviews.epoch };
      }));
    } catch { return; }
    if (!jobs.length) return;
    const records = await LaterOnBookmarkPreviews.load(jobs, node => enqueue(async () => {
      const latest = await liveConfig();
      if ((latest.scopeId || null) !== (config.scopeId || null) || generation !== LaterOnBookmarkPreviews.epoch) fail('bookmarkPreviewUnavailable');
      if ((await liveNodes([node.id], latest)).get(node.id)?.url !== node.url) fail('bookmarkPreviewUnavailable');
    }));
    await enqueue(async () => {
      if (sourceIndex()) await waitForIdle(true);
      let latest;
      try { latest = await context(false); } catch { return; }
      if (generation !== LaterOnBookmarkPreviews.epoch || latest.config.scopeId !== config.scopeId) return;
      const valid = records.filter(latest.current);
      await LaterOnBookmarkPreviews.commit(valid, latest.all, generation);
      const stored = await readQueue();
      const attempted = { ...(stored.attempted || {}) };
      const previews = (await chrome.storage.local.get('laterOnBookmarkPreviews')).laterOnBookmarkPreviews || {};
      for (const job of jobs) {
        const record = valid.find(record => record.id === job.id), cached = previews[job.id];
        attempted[job.id] = { url: job.url, at: Date.now(), sourceImage: record?.sourceImage || cached?.sourceImage || '',
          complete: !!record && !record.error && !!(record.image || cached?.image) && !!(record.description || cached?.description) };
      }
      await writeQueue({ ...stored, attempted,
        pending: (stored.pending || []).filter(job => !jobs.some(done => done.id === job.id && done.url === job.url)) });
      await publishWorkedPreviews(latest.config);
    });
  }
  // A preview batch changes covers only: with the device-local index this is
  // a bounded patch; without it the full mirror is republished as before.
  async function publishWorkedPreviews(config) {
    const info = await readMeta();
    if (indexApi() && info?.enabled && !info.error && (info.scopeId || null) === (config.scopeId || null)) {
      return publishPreviews(LaterOnBookmarkPreviews.takeChanges(), info);
    }
    return refreshNow();
  }
  function kickPreviews() {
    if (previewRunning) { previewAgain = true; return previewRunning; }
    previewRunning = workPreviews().catch(() => {}).finally(() => {
      previewRunning = null;
      if (previewAgain) { previewAgain = false; kickPreviews(); }
    });
    return previewRunning;
  }
  function schedulePreviews() {
    if (previewTimer) return;
    previewTimer = setTimeout(() => { previewTimer = null; kickPreviews(); }, 1200);
    previewTimer.unref?.();
  }
  async function updatePriority(visible, visibleKey, stored, small = false) {
    const ids = new Set(visible.map(node => node.id));
    let attempted = stored.attempted || {}, changedAttempts = false;
    const pending = [...stored.pending || []];
    if (stored.visibleKey !== visibleKey) {
      const candidates = visible.filter(node => attempted[node.id]?.url === node.url && attempted[node.id].complete && LaterOnBookmarkPreviews.publicUrl(node.url));
      const previews = candidates.length ? (await chrome.storage.local.get('laterOnBookmarkPreviews')).laterOnBookmarkPreviews || {} : {};
      for (const node of candidates) {
        if (previews[node.id]?.image) continue;
        if (!changedAttempts) attempted = { ...attempted };
        changedAttempts = true; delete attempted[node.id];
        if (!pending.some(job => job.id === node.id && job.url === node.url)) pending.push(node);
      }
    }
    await LaterOnBookmarkPreviews.prioritize(visible);
    const next = { ...stored, attempted, visible, visibleKey,
      pending: [...pending.filter(job => ids.has(job.id)), ...pending.filter(job => !ids.has(job.id))] };
    // View order is durably held in the tiny VISIBLE key. Only a real retry
    // change rewrites the potentially large attempted-job history.
    if (small ? changedAttempts : !same(next, stored)) await writeQueue(next);
    return next;
  }
  // A view announces the pages it shows. Only those ids are checked against
  // native bookmarks, and the reply is a few counts: the view already has its
  // data, so the full mirror is neither read nor sent back.
  async function prioritizePreviews(message) {
    if (!Array.isArray(message.ids) || message.ids.some(id => typeof id !== 'string')) fail('bookmarkInvalidItems');
    if (sourceIndex()) {
      const config = await liveConfig(), requested = [...new Set(message.ids.slice(0, 144))];
      const native = await liveNodes(requested, config);
      const visible = requested.filter(id => native.has(id)).map(id => ({ id, url: native.get(id).url }));
      const visibleKey = typeof message.viewKey === 'string' ? message.viewKey.slice(0, 20000) : JSON.stringify(visible.map(node => node.id));
      const previous = (await chrome.storage.local.get(VISIBLE))[VISIBLE];
      await chrome.storage.local.set({ [VISIBLE]: { scopeId: config.scopeId || null, visible, visibleKey, processedKey: previous?.processedKey || '' } });
      await LaterOnBookmarkPreviews.prioritize(visible);
      schedulePreviews();
      return { visible: visible.length, pending: 0, prioritized: 0, deferred: true };
    }
    const reply = await enqueue(async () => {
      const config = await liveConfig();
      const requested = [...new Set(message.ids.slice(0, 144))];
      const native = await liveNodes(requested, config);
      const visible = requested.filter(id => native.has(id)).map(id => ({ id, url: native.get(id).url }));
      const stored = await readQueue();
      const ids = new Set(visible.map(node => node.id));
      const visibleKey = typeof message.viewKey === 'string' ? message.viewKey.slice(0, 20000) : JSON.stringify([...ids]);
      const next = await updatePriority(visible, visibleKey, stored);
      return { visible: visible.length, pending: next.pending.length, prioritized: next.pending.filter(job => ids.has(job.id)).length };
    });
    if (reply.pending) kickPreviews();
    return reply;
  }
  async function context(includePreviews = true) {
    const config = await readConfig();
    if (!config.enabled) fail('bookmarkDisabled');
    if (!await permission()) fail('bookmarkPermission');
    const { all, state } = await snapshot(config, includePreviews);
    if (state.error) fail(state.error);
    const byId = byIdOf(all);
    const node = id => {
      const result = byId.get(id);
      if (!result || !scopedIn(all, config.scopeId, result)) fail('bookmarkOutOfScope');
      return result;
    };
    const current = record => {
      const result = byId.get(record?.id);
      return !!result && result.url === record.url && scopedIn(all, config.scopeId, result);
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
    return { config, all, node, folder, editable, current };
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
    try { return { ...await refreshNow({ urgent: true }), ...extra, committed: true }; }
    catch { return { ...await readState().catch(() => ({ nodes: [], folders: [] })), enabled: true, error: 'bookmarkRefreshFailed', ...extra, committed: true }; }
  }
  // Opening a view returns the last published mirror when it still matches
  // the saved scope and permission; a stale check is queued behind it.
  async function cachedOrLive() {
    const [config, stored] = await Promise.all([readConfig(), sourceIndex()
      ? Promise.all([readMeta(), searchSource({ urgent: true }).catch(() => null)]).then(([info, state]) => ({ [STATE]: state, [META]: info }))
      : chrome.storage.local.get([STATE, META])]);
    const state = stored[STATE], info = stored[META] || null;
    if (info) { meta = info; metaLoaded = true; }
    const usable = state && info && (state.enabled === true) === (config.enabled === true)
      && (state.scopeId || null) === (config.scopeId || null) && !state.error
      && (!config.enabled || await permission());
    if (!usable) return refreshNow({ urgent: true });
    if (config.enabled && Date.now() - (info.checkedAt || 0) > RECHECK) sourceIndex() ? scheduleRecovery() : refresh().catch(() => {});
    if (config.enabled) ensureIndex(null, info).catch(() => {});
    if (config.enabled && (sourceIndex() || info.updatedAt !== state.updatedAt)) {
      // A full-view fallback can run while the disposable index is being
      // repaired. Preview patches live in their small cache, so merge them
      // here without rewriting or broadcasting the large native mirror.
      try {
        const previews = (await chrome.storage.local.get('laterOnBookmarkPreviews')).laterOnBookmarkPreviews || {};
        const nodes = (state.nodes || []).map(node => {
          if (!node.url) return node;
          const { preview, ...plain } = node;
          return previews[node.id]?.url === node.url ? { ...plain, preview: previews[node.id] } : plain;
        });
        return { ...state, nodes, updatedAt: info.updatedAt };
      } catch {}
    }
    return state;
  }
  // Small freshness probe for bounded views: verifies when the last check is
  // old (or forced) and returns only revision facts, never the mirror itself.
  async function check(message) {
    const before = await readMeta();
    if (message.force === true || !before || Date.now() - (before.checkedAt || 0) > RECHECK) {
      if (sourceIndex() && message.force !== true) scheduleRecovery();
      else await enqueueUrgent(() => refreshNow({ urgent: true }));
    }
    const after = await readMeta();
    return { updatedAt: after?.updatedAt || 0, checkedAt: after?.checkedAt || 0, signature: after?.signature || '',
      enabled: after?.enabled === true, scopeId: after?.scopeId || null, error: after?.error || null,
      changed: (before?.signature || '') !== (after?.signature || '') };
  }
  const urlKey = value => {
    try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''; }
    catch { return ''; }
  };
  // Reading pages ask only about the cards they show. The URL set is built
  // once per published mirror and never leaves the worker.
  async function membership(message) {
    if (!Array.isArray(message.urls) || message.urls.some(url => typeof url !== 'string')) fail('bookmarkInvalidItems');
    const config = await readConfig();
    if (!config.enabled || !await permission()) return { matches: [], valid: false };
    const info = await readMeta();
    if (sourceIndex()) {
      const urls = [...new Set(message.urls.slice(0, 200).map(urlKey))].filter(Boolean);
      const indexed = await indexApi().membership?.(urls, { bookmarkConfig: config, bookmarkPermission: true });
      if (indexed && (indexed.updatedAt || 0) >= (info?.updatedAt || 0) && (info?.nativeVerifiedAt || 0) >= latestNativeChange) return { ...indexed, valid: true, scopeId: config.scopeId || null };
      const matches = [], memo = new Map();
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(8, urls.length) }, async () => {
        while (cursor < urls.length) {
          const url = urls[cursor++];
          let native = []; try { native = await chrome.bookmarks.search({ url }); } catch {}
          for (const node of native || []) if (urlKey(node.url) === url && await withinScope(node, config.scopeId || null, memo)) { matches.push(url); break; }
        }
      }));
      return { matches, valid: true, scopeId: config.scopeId || null, updatedAt: info?.updatedAt || 0 };
    }
    if (!membershipCache || membershipCache.signature !== info?.leanSignature) {
      const stored = await chrome.storage.local.get(SEARCH);
      const state = stored[SEARCH] || await readState();
      const valid = state.enabled === true && !state.error && (state.scopeId || null) === (config.scopeId || null);
      const urls = new Set();
      if (valid) for (const node of state.nodes || []) { const key = urlKey(node.url); if (key) urls.add(key); }
      membershipCache = { signature: info?.leanSignature, valid, urls, scopeId: state.scopeId || null, updatedAt: state.updatedAt || 0 };
    }
    if (!membershipCache.valid || membershipCache.scopeId !== (config.scopeId || null)) return { matches: [], valid: false };
    const matches = [...new Set(message.urls.slice(0, 200).map(urlKey))].filter(key => key && membershipCache.urls.has(key));
    return { matches, valid: true, scopeId: membershipCache.scopeId, updatedAt: membershipCache.updatedAt };
  }
  async function execute(message) {
    if (message.type === 'BOOKMARKS_GET') return message.force === true ? refreshNow({ urgent: true }) : cachedOrLive();
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
      return refreshNow({ urgent: true });
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
          const latest = await context(false);
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
    const requested = [...new Set(message.ids)].slice(0, 12);
    const initial = await enqueue(async () => {
      const config = await liveConfig();
      if (config.scopeId && typeof chrome.bookmarks?.get === 'function') {
        const scope = await chrome.bookmarks.get(config.scopeId).then(list => list?.[0], () => null);
        if (!scope || scope.url) fail('bookmarkScopeMissing');
      }
      const current = await liveNodes(requested, config, { includeFolders: true, strict: true });
      return { config, nodes: requested.map(id => current.get(id)).filter(node => node?.url) };
    });
    const generation = previews.epoch, nodes = initial.nodes;
    const records = await previews.load(nodes, node => enqueue(async () => {
      const latest = await liveConfig();
      if ((latest.scopeId || null) !== (initial.config.scopeId || null) || generation !== previews.epoch) fail('bookmarkPreviewUnavailable');
      if ((await liveNodes([node.id], latest)).get(node.id)?.url !== node.url) fail('bookmarkPreviewUnavailable');
    }));
    return enqueue(async () => {
      // Cache pruning needs the full native URL set once, after the active
      // search has finished. Per-page access checks above remain bounded.
      if (sourceIndex()) await waitForIdle(true);
      let latest;
      try { latest = await context(false); } catch {
        return { ...await refreshNow(), previewResults: { updated: 0, failed: nodes.length, cancelled: true } };
      }
      if (generation !== previews.epoch || latest.config.scopeId !== initial.config.scopeId) {
        return { ...await refreshNow(), previewResults: { updated: 0, failed: nodes.length, cancelled: true } };
      }
      const valid = records.filter(latest.current);
      await previews.commit(valid, latest.all, generation);
      return { ...await publishWorkedPreviews(latest.config), previewResults: { updated: valid.filter(record => !record.error && (record.image || record.description)).length,
        failed: nodes.length - valid.filter(record => !record.error && (record.image || record.description)).length } };
    });
  }
  // A disposable index may be missing immediately after an upgrade. Native
  // APIs can still provide a real first page without reading the large mirror.
  async function boundedView(message) {
    if (message.background !== true) viewActiveUntil = Date.now() + 1200;
    const config = await liveConfig();
    const selected = typeof message.selected === 'string' ? message.selected : '';
    const query = String(message.query || '').trim().slice(0, 500);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(message.limit) || 12)));
    const folderLimit = Math.max(1, Math.min(100, Math.floor(Number(message.folderLimit) || 24)));
    const [info, required] = await Promise.all([readMeta(), chrome.storage.local.get('laterOnQuickSearchPending')]);
    const ancestors = new Map(), lookups = new Map();
    const get = id => {
      if (!lookups.has(id)) lookups.set(id, chrome.bookmarks.get(id).then(list => {
        const node = list?.[0]; if (node) ancestors.set(id, node); return node;
      }, () => null));
      return lookups.get(id);
    };
    const scopeMemo = new Map(), selectedMemo = new Map();
    async function inside(node, root, memo, seen = new Set()) {
      if (!root) return true;
      if (!node || seen.has(node.id)) return false;
      if (node.id === root) return true;
      if (memo.has(node.id)) return memo.get(node.id);
      const nextSeen = new Set(seen); nextSeen.add(node.id);
      const result = Promise.resolve().then(async () => node.parentId ? inside(await get(node.parentId), root, memo, nextSeen) : false);
      memo.set(node.id, result); return result;
    }
    async function parents(node) {
      for (let id = node.parentId, seen = new Set(); id && !seen.has(id); ) {
        seen.add(id); const parent = await get(id); if (!parent) break; id = parent.parentId;
      }
    }
    if (config.scopeId) {
      const scope = await get(config.scopeId);
      if (!scope || scope.url) fail('bookmarkScopeMissing');
    }
    if (selected) {
      const folder = await get(selected);
      if (!folder || folder.url || !await inside(folder, config.scopeId || null, scopeMemo)) fail('bookmarkOutOfScope');
    }
    const parent = selected || config.scopeId || '0';
    let children, candidates;
    if (selected && !query) { children = await chrome.bookmarks.getChildren(parent); candidates = children.filter(node => node.url); }
    else if (query && (selected || config.scopeId)) {
      children = await chrome.bookmarks.getChildren(parent);
      const queryText = query.toLocaleLowerCase(), owner = await get(parent);
      if (owner) await parents(owner);
      const text = node => `${node.title || ''} ${node.url || ''}`.toLocaleLowerCase();
      const chainMatches = node => {
        for (let current = node, seen = new Set(); current && !seen.has(current.id); current = ancestors.get(current.parentId)) {
          seen.add(current.id); if (text(current).includes(queryText)) return true;
        }
        return false;
      };
      const collect = (list, folder) => list.filter(node => node.url && (chainMatches(folder) || text(node).includes(queryText)));
      candidates = collect(children, owner);
      if (candidates.length < limit) for (const folder of children.filter(node => !node.url).slice(0, 8)) {
        ancestors.set(folder.id, folder);
        const list = await chrome.bookmarks.getChildren(folder.id);
        candidates.push(...collect(list, folder));
        if (candidates.length >= limit) break;
      }
      if (candidates.length < limit) {
        const ids = new Set(candidates.map(node => node.id));
        candidates.push(...(await chrome.bookmarks.search(query)).slice(0, 512).filter(node => !ids.has(node.id)));
      }
    }
    else [children, candidates] = await Promise.all([chrome.bookmarks.getChildren(parent), query
      ? chrome.bookmarks.search(query) : chrome.bookmarks.getRecent(Math.min(100, config.scopeId ? limit * 4 : limit))]);
    const folders = children.filter(node => !node.url).slice(0, folderLimit);
    const accepted = [], folderMatches = [];
    let cursor = 0;
    // Counts for a provisional query are unknown. Stop after a small visible
    // slice, rather than checking all matching bookmarks and their ancestors.
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (cursor < candidates.length && accepted.length <= limit) {
        const position = cursor++, node = candidates[position];
        if (!await inside(node, config.scopeId || null, scopeMemo) || selected && query && !await inside(node, selected, selectedMemo)) continue;
        if (node.url) accepted.push({ position, node });
        else if (query && folderMatches.length < folderLimit) folderMatches.push(node);
      }
    }));
    let pages = accepted.sort((a, b) => a.position - b.position).map(value => value.node);
    // Recent global bookmarks may contain no entries from a small selected
    // scope. Its direct children still provide real pages immediately.
    if (!query && !selected && config.scopeId && pages.length < limit) {
      const ids = new Set(pages.map(node => node.id));
      pages.push(...children.filter(node => node.url && !ids.has(node.id)).slice(0, limit + 1 - pages.length));
    }
    if (query && !pages.length && folderMatches.length) {
      for (const folder of folderMatches.slice(0, 8)) {
        ancestors.set(folder.id, folder);
        const list = await chrome.bookmarks.getChildren(folder.id);
        pages.push(...list.filter(node => node.url).slice(0, limit + 1 - pages.length));
        if (pages.length >= limit) break;
      }
      folders.splice(0, folders.length, ...folderMatches);
    }
    const hasMore = pages.length > limit || query && cursor < candidates.length;
    pages = pages.slice(0, limit);
    await Promise.all([...pages, ...folders].map(parents));
    if (selected) await get(selected);
    const clean = node => {
      const path = [], seen = new Set();
      let readonly = !!node.unmodifiable;
      for (let current = node.url ? ancestors.get(node.parentId) : node; current?.parentId && !seen.has(current.id); current = ancestors.get(current.parentId)) {
        seen.add(current.id); readonly ||= !!current.unmodifiable; if (current.title) path.unshift(current.title);
      }
      return { id: node.id, parentId: node.parentId || null, title: node.title || '', path: path.join(' / '),
        ...(node.url ? { url: node.url } : { summary: { pages: 0, folders: 0, previews: [], pending: true } }),
        ...(Number.isFinite(node.dateAdded) ? { dateAdded: node.dateAdded } : {}),
        ...(node.folderType ? { folderType: node.folderType } : {}),
        protected: readonly || !node.parentId || node.parentId === '0' || !!node.folderType || node.id === config.scopeId,
        writable: !node.url && !!node.parentId && !readonly };
    };
    const allFolders = [...new Map([...ancestors.values(), ...folders].filter(node => node && !node.url && node.parentId).map(node => [node.id, clean(node)])).values()];
    const scopedFolders = [];
    for (const folder of allFolders) if (await inside(folder, config.scopeId || null, scopeMemo)) scopedFolders.push(folder);
    const scopedIds = new Set(scopedFolders.map(node => node.id));
    const totalFolders = query ? scopedFolders.filter(node => selected ? node.parentId === selected
      : node.id === config.scopeId || !scopedIds.has(node.parentId)).filter(node => `${node.title} ${node.path}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).length
      : !selected && config.scopeId ? 1 : children.filter(node => !node.url).length;
    const known = !query && !selected && info?.enabled && !info.error && (info.scopeId || null) === (config.scopeId || null)
      && (info.checkedAt || 0) >= latestNativeChange && (info.nativeVerifiedAt || 0) >= (required?.laterOnQuickSearchPending?.nativeAt || 0);
    const totalPages = selected && !query ? children.filter(node => node.url).length : known ? info.pages : pages.length;
    if (sourceIndex()) {
      if (sourceCache && info && sourceCache.updatedAt === info.updatedAt) ensureIndex(sourceCache, info).catch(() => {});
      else scheduleRecovery();
    }
    else if (info) ensureIndex(null, info).catch(() => {});
    else scheduleRecovery();
    return { enabled: true, scopeId: config.scopeId || null, error: null, updatedAt: info?.updatedAt || 0,
      nodes: [...scopedFolders, ...pages.map(clean)], folders: allFolders, partial: true, provisional: true,
      view: { selected, query, totalPages: Math.max(pages.length, Number(totalPages) || 0), totalFolders,
        shownPages: pages.length, limit, folderLimit, provisional: true, hasMore, countKnown: !!known || !!selected && !query } };
  }
  const handle = message => message.type === 'BOOKMARKS_MEMBERSHIP' ? membership(message)
    : message.type === 'BOOKMARKS_ACTIVITY' ? (viewActiveUntil = Date.now() + 1200, Promise.resolve({ active: true }))
    : message.type === 'BOOKMARKS_VIEW' ? boundedView(message)
    : message.type === 'BOOKMARKS_CHECK' ? check(message)
    : message.type === 'BOOKMARKS_PREVIEWS'
      ? message.automatic ? prioritizePreviews(message) : loadPreviews(message) : enqueueUrgent(() => execute(message));
  function onNativeChange() {
    latestNativeChange = Date.now();
    if (eventPending || importing) return;
    eventPending = true;
    (async () => {
      if (sourceIndex()) await new Promise(resolve => setTimeout(resolve, 300));
      await waitForIdle();
      return enqueue(() => { eventPending = false; return refreshNow(); });
    })().catch(() => { eventPending = false; });
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
  chrome.runtime.onStartup?.addListener(() => { sourceIndex() ? scheduleRecovery() : refresh().catch(() => {}); });
  chrome.runtime.onInstalled?.addListener(() => { sourceIndex() ? scheduleRecovery() : refresh().catch(() => {}); });
  chrome.alarms?.onAlarm?.addListener(alarm => {
    if (alarm.name === ALARM) sourceIndex() ? scheduleRecovery() : refresh().catch(() => {});
    if (alarm.name === PREVIEW_ALARM) kickPreviews();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith('BOOKMARKS_')) return;
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) { respond({ ok: false, error: 'bookmarkPermission' }); return; }
    handle(message).then(state => respond({ ok: true, state }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes[META]) { meta = changes[META].newValue || null; metaLoaded = true; membershipCache = null; }
    if (area === 'local' && changes[PREVIEWS]) queueMemo = changes[PREVIEWS].newValue || null;
    if (area === 'local' && (changes[STATE] || changes[CONFIG])) membershipCache = null;
  });
  // No wake-time refresh: invoking LaterOn must not rebuild the whole mirror.
  // Browser start, install, permission changes, native events and the periodic
  // alarm keep the mirror current; stale cached reads schedule a quiet recheck.
  globalThis.LaterOnBookmarkSync = { handle, refresh, membership, searchSource, verify: scheduleRecovery, indexIdle: () => indexRunning || Promise.resolve() };
})();

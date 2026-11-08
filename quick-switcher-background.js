// Search stays in the extension worker: pages receive only the current result
// slice, never covers, the bookmark tree or the full reading library.
(() => {
  const KEYS = ['laterOnItems', 'laterOnProjects', 'laterOnBookmarkSearchState', 'laterOnBookmarkConfig'];
  const READING_KEYS = ['laterOnItems', 'laterOnProjects', 'laterOnBookmarkConfig'];
  const popupUrl = () => chrome.runtime.getURL('quick-switcher.html');
  const PENDING = 'laterOnQuickSearchPending';
  let generation = 0, cached = null, building = null, stylesPromise = null;
  let dirty = false, thinKnown = null, warmTimer = null, preparing = null, forceBuild = false;
  // The prepared index is replaced only by an atomic commit. While a rebuild
  // runs, the last ready snapshot keeps serving; a monotonic source revision
  // (persisted in a tiny key) tells a restarted worker whether it is stale.
  let sourceRevision = 0, pendingRead = null, bookmarksChanged = false;
  let nativeAt = 0, nativeImport = false;
  const nativeIds = new Set(), nativeEvents = new Map();
  let liveSource = null, live = null, liveReadingTask = null, readingGeneration = 0;
  let presentingUntil = 0;
  let tabGeneration = 0, tabRows = null, tabModel = null, tabTask = null, tabNotice = null, modeGeneration = 0, permissionGeneration = 0;
  let tabDeltas = [];
  const queries = new Map();
  const leanTab = tab => Object.fromEntries(['id', 'windowId', 'index', 'url', 'pendingUrl', 'title', 'active', 'lastAccessed', 'incognito']
    .filter(key => tab?.[key] !== undefined).map(key => [key, tab[key]]));
  function tabsChanged() {
    tabGeneration++; tabModel = null;
    if (tabNotice) return;
    tabNotice = setTimeout(() => {
      tabNotice = null;
      const message = { type: 'LATERON_QUICK_SWITCHER_CHANGED', change: 'tabs', generation, tabGeneration };
      globalThis.LaterOnContentMessages?.broadcast(message);
      try { chrome.runtime.sendMessage?.(message)?.catch?.(() => {}); } catch {}
    }, 25);
    tabNotice.unref?.();
  }
  function changeTab(id, changes = {}, full = null) {
    if (tabRows) {
      const previous = tabRows.get(id);
      const next = full ? leanTab(full) : previous ? leanTab({ ...previous, ...changes, id }) : null;
      if (next && JSON.stringify(next) === JSON.stringify(previous)) return;
      if (next) tabRows.set(id, next);
      else tabRows = null;
    } else if (tabTask) {
      const value = full ? leanTab(full) : null, patch = { ...changes };
      tabDeltas.push(rows => {
        const previous = rows.get(id);
        if (value) rows.set(id, value);
        else if (previous) rows.set(id, leanTab({ ...previous, ...patch, id }));
      });
    }
    tabsChanged();
  }
  async function liveTabs() {
    if (tabModel) return tabModel;
    if (!tabRows) {
      if (tabTask) return tabTask;
      // Subscribe before the native snapshot request, then replay its overlap
      // events. Chasing a quiet generation would never finish under creation
      // or navigation churn; one snapshot plus ordered deltas is sufficient.
      tabDeltas = [];
      const task = Promise.resolve().then(() => chrome.tabs.query({})).then(tabs => {
        tabRows = new Map((tabs || []).filter(tab => Number.isInteger(tab?.id)).map(tab => [tab.id, leanTab(tab)]));
        for (const apply of tabDeltas) apply(tabRows);
        tabDeltas = [];
        return liveTabs();
      });
      tabTask = task;
      try { return await task; } finally { if (tabTask === task) tabTask = null; }
    }
    const index = LaterOnQuickSearch.buildTabs([...tabRows.values()].filter(tab => !isPopup(tab.pendingUrl || tab.url)));
    return tabModel = { index, generation: tabGeneration };
  }
  chrome.tabs.onCreated?.addListener?.(tab => changeTab(tab.id, {}, tab));
  chrome.tabs.onUpdated?.addListener?.((id, changes, tab) => {
    if (['url', 'pendingUrl', 'title', 'status'].some(key => Object.hasOwn(changes || {}, key))) changeTab(id, changes, tab);
  });
  chrome.tabs.onMoved?.addListener?.((id, info) => changeTab(id, { windowId: info.windowId, index: info.toIndex }));
  function removeTab(id) {
    if (tabRows) tabRows.delete(id);
    else if (tabTask) tabDeltas.push(rows => rows.delete(id));
    tabsChanged();
  }
  chrome.tabs.onDetached?.addListener?.(removeTab);
  chrome.tabs.onAttached?.addListener?.((id, info) => {
    const version = tabGeneration;
    Promise.resolve().then(() => chrome.tabs.get(id)).then(tab => {
      if (version === tabGeneration) changeTab(id, { windowId: info.newWindowId, index: info.newPosition }, tab);
      else { tabRows = null; tabsChanged(); }
    }).catch(() => { tabRows = null; tabsChanged(); });
  });
  const activeClients = new Map();
  const clientKey = sender => sender?.documentId ? `document:${sender.documentId}`
    : sender?.tab?.id ? `tab:${sender.tab.id}` : `page:${sender?.url || ''}`;
  const interactive = () => {
    const now = Date.now();
    for (const [key, value] of activeClients) if (now - value.at > 60000) activeClients.delete(key);
    return activeClients.size > 0 || now < presentingUntil;
  };
  const opening = new Map();
  const persistent = () => globalThis.LaterOnLocalIndex?.supported?.() === true;
  function scheduleWarm(force = false, delay = 300) {
    if (force) forceBuild = true;
    if (!persistent() || warmTimer) return;
    warmTimer = setTimeout(() => {
      warmTimer = null;
      if (interactive()) { scheduleWarm(false, 1000); return; }
      preparePersistent().catch(() => {});
    }, delay);
    warmTimer.unref?.();
  }
  function resumeWarm() {
    const scheduled = !!warmTimer;
    if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
    if (scheduled || dirty || forceBuild) scheduleWarm();
  }
  chrome.tabs.onRemoved?.addListener?.(tabId => {
    removeTab(tabId);
    for (const [key, value] of activeClients) if (value.tabId === tabId) activeClients.delete(key);
    if ((dirty || forceBuild) && !interactive()) resumeWarm();
  });
  chrome.tabs.onActivated?.addListener?.(info => {
    const at = Date.now(), activate = rows => {
      for (const [id, tab] of rows) if (tab.windowId === info.windowId)
        rows.set(id, { ...tab, active: id === info.tabId, ...(id === info.tabId ? { lastAccessed: at } : {}) });
    };
    if (tabRows) activate(tabRows);
    else if (tabTask) tabDeltas.push(activate);
    if (tabRows && !tabRows.has(info.tabId)) tabRows = null;
    tabsChanged();
    for (const [key, value] of activeClients) if (value.windowId === info.windowId && value.tabId && value.tabId !== info.tabId) activeClients.delete(key);
    if ((dirty || forceBuild) && !interactive()) resumeWarm();
  });
  function loadPending() {
    if (!pendingRead) pendingRead = Promise.resolve().then(() => chrome.storage.local.get(PENDING))
      .then(stored => {
        const pending = stored?.[PENDING];
        const revision = Number(pending?.revision) || 0;
        if (revision) dirty = true;
        if (revision && pending?.bookmarks === true) bookmarksChanged = true;
        nativeAt = Math.max(nativeAt, Number(pending?.nativeAt) || 0);
        for (const id of pending?.nativeIds || []) if (typeof id === 'string' && nativeIds.size < 100) nativeIds.add(id);
        sourceRevision = Math.max(sourceRevision, revision);
        return revision;
      }).catch(() => 0);
    return pendingRead.then(revision => Math.max(revision, dirty ? sourceRevision : 0));
  }
  function announce(fresh) {
    const message = { type: 'LATERON_QUICK_SWITCHER_CHANGED', generation, ...(fresh ? { fresh: true } : {}) };
    globalThis.LaterOnContentMessages?.broadcast(message);
    if (fresh) { try { chrome.runtime.sendMessage?.(message)?.catch?.(() => {}); } catch {} }
  }
  const invalidate = ({ bookmarks = false, reading = false } = {}) => {
    generation++; cached = null; building = null; preparing = null;
    if (reading) { readingGeneration++; live = null; liveReadingTask = null; }
    if (bookmarks) bookmarksChanged = true;
    if (!persistent()) { dirty = true; announce(false); return; }
    dirty = true;
    sourceRevision = Math.max(Date.now(), sourceRevision + 1);
    pendingRead = Promise.resolve(sourceRevision);
    const revision = sourceRevision;
    marker(() => sourceRevision === revision ? chrome.storage.local.set?.({ [PENDING]: { revision, bookmarks: bookmarksChanged, nativeAt, nativeIds: [...nativeIds] } }) : null).then(() => announce(false));
    scheduleWarm();
  };
  // Marker writes and clears run in order. A clear re-checks the current
  // revision when it runs, so it can never delete a newer change's marker.
  let markers = Promise.resolve();
  function marker(task) {
    const run = markers.then(() => task());
    markers = run.catch(() => {});
    return markers;
  }
  const clearMarker = revision => marker(() => !dirty && revision >= sourceRevision ? chrome.storage.local.remove?.(PENDING) : null);
  function sameFields(change, fields) {
    const old = change?.oldValue, next = change?.newValue;
    return Array.isArray(old) && Array.isArray(next) && old.length === next.length
      && old.every((entry, i) => fields.every(key => entry?.[key] === next[i]?.[key]));
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.laterOnSettings && JSON.stringify(changes.laterOnSettings.oldValue?.quickSwitcherModes)
      !== JSON.stringify(changes.laterOnSettings.newValue?.quickSwitcherModes)) {
      modeGeneration++;
      const message = { type: 'LATERON_QUICK_SWITCHER_CHANGED', generation, modeGeneration };
      globalThis.LaterOnContentMessages?.broadcast(message);
      try { chrome.runtime.sendMessage?.(message)?.catch?.(() => {}); } catch {}
    }
    const items = changes.laterOnItems && !sameFields(changes.laterOnItems, ['id', 'url', 'title', 'titleEdited', 'source', 'projectId', 'savedAt']);
    const projects = changes.laterOnProjects && !sameFields(changes.laterOnProjects, ['id', 'name']);
    const reading = !!(items || projects);
    // Keep the current Reading source for provisional results; status-only
    // edits change no search field but must not leave the live copy behind.
    if (changes.laterOnItems || changes.laterOnProjects) {
      if (changes.laterOnItems && Array.isArray(changes.laterOnItems.newValue) && liveSource) liveSource = { ...liveSource, items: changes.laterOnItems.newValue };
      else if (changes.laterOnItems) liveSource = null;
      if (changes.laterOnProjects && liveSource) liveSource = { ...liveSource, projects: changes.laterOnProjects.newValue || [] };
    }
    if (changes.laterOnBookmarkSearchState) thinKnown = true;
    if (nativeAt && Number(changes.laterOnBookmarkStateMeta?.newValue?.nativeVerifiedAt) >= nativeAt) {
      nativeAt = 0; scheduleWarm();
    }
    const facts = changes.laterOnBookmarkStateMeta;
    if (facts?.newValue?.source === 'indexeddb' && (facts.newValue.leanSignature !== facts.oldValue?.leanSignature
      || facts.newValue.enabled !== facts.oldValue?.enabled || facts.newValue.error !== facts.oldValue?.error
      || (facts.newValue.scopeId || null) !== (facts.oldValue?.scopeId || null))) { invalidate({ bookmarks: true, reading }); return; }
    const removedMirror = changes.laterOnBookmarkSearchState && !changes.laterOnBookmarkSearchState.newValue && persistent()
      && typeof globalThis.LaterOnBookmarkSync?.searchSource === 'function';
    if (changes.laterOnBookmarkSearchState && !removedMirror || changes.laterOnBookmarkConfig) { invalidate({ bookmarks: true, reading }); return; }
    if (reading) { invalidate({ reading: true, bookmarks: !!changes.laterOnBookmarkState && thinKnown !== true }); return; }
    if (changes.laterOnBookmarkState && thinKnown !== true) {
      if (!persistent()) { invalidate({ bookmarks: true }); return; }
      globalThis.LaterOnLocalIndex.info().then(meta => {
        thinKnown = meta?.thinBookmarks === true;
        if (!thinKnown) invalidate({ bookmarks: true });
      }).catch(() => invalidate({ bookmarks: true }));
    }
  });
  // Persistent indexes hold separate Reading and combined variants. Permission
  // changes select the Reading variant immediately, without rebuilding either.
  const permissionChanged = permissions => {
    permissionGeneration++;
    if (permissions?.permissions?.includes('tabs') || permissions?.origins?.length) { tabRows = null; tabsChanged(); }
    cached = null;
    registerNativeEvents();
    globalThis.LaterOnContentMessages?.broadcast({ type: 'LATERON_QUICK_SWITCHER_CHANGED', generation });
    if (!persistent()) invalidate();
  };
  chrome.permissions?.onRemoved?.addListener(permissionChanged);
  chrome.permissions?.onAdded?.addListener(permissionChanged);
  function registerNativeEvents() {
    if (!chrome.bookmarks) return;
    const changed = id => {
      if (typeof id === 'string' && nativeIds.size < 100) nativeIds.add(id);
      nativeAt = Date.now(); invalidate({ bookmarks: true });
    };
    const handlers = {
      onCreated: changed, onChanged: changed, onRemoved: changed, onMoved: changed, onChildrenReordered: changed,
      onImportBegan: () => { nativeImport = true; changed(); },
      onImportEnded: () => { nativeImport = false; changed(); }
    };
    for (const [name, handler] of Object.entries(handlers)) {
      const event = chrome.bookmarks[name];
      if (!event?.addListener || nativeEvents.has(name)) continue;
      try { event.addListener(handler); nativeEvents.set(name, handler); } catch {}
    }
  }
  registerNativeEvents();
  const ownPage = url => typeof url === 'string' && url.startsWith(chrome.runtime.getURL(''));
  const isPopup = url => typeof url === 'string' && url.split('?')[0] === popupUrl();
  const webUrl = value => {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !/^https?:\/\/[^/]*@/.test(url.href) ? url.href : ''; }
    catch { return ''; }
  };
  const allowed = sender => ownPage(sender?.url) || !!sender?.tab?.id && !!webUrl(sender.url || sender.tab.url);
  function deadline(promise, milliseconds = 2500) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('quickSwitcherUnavailable')), milliseconds); })])
      .finally(() => clearTimeout(timer));
  }
  async function index(current) {
    const version = generation;
    if (!cached) {
      if (!building) {
        const task = (async () => {
          const stored = await chrome.storage.local.get(KEYS);
          if (!stored.laterOnBookmarkSearchState) Object.assign(stored, await chrome.storage.local.get('laterOnBookmarkState'));
          thinKnown = !!stored.laterOnBookmarkSearchState;
          if (version === generation) cached = { stored, variants: new Map() };
        })();
        building = task;
        task.finally(() => { if (building === task) building = null; }).catch(() => {});
      }
      await building;
      if (version !== generation) return index(current);
    }
    const key = JSON.stringify([current.sources, current.bookmarkPermission, current.bookmarkConfig]);
    if (!cached.variants.has(key)) {
      const stored = cached.stored;
      cached.variants.set(key, LaterOnQuickSearch.build({ items: stored.laterOnItems, projects: stored.laterOnProjects,
        bookmarks: stored.laterOnBookmarkSearchState || stored.laterOnBookmarkState, sources: current.sources,
        bookmarkConfig: current.bookmarkPermission ? current.bookmarkConfig : { enabled: false } }));
    }
    return cached.variants.get(key);
  }
  async function context(modeId = 'default') {
    const stored = await chrome.storage.local.get(['laterOnSettings', 'laterOnBookmarkConfig']);
    const mode = LaterOnQuickModes.get(stored.laterOnSettings?.quickSwitcherModes, modeId);
    const permission = mode.sources.includes('bookmarks') && await Promise.resolve()
      .then(() => chrome.permissions?.contains({ permissions: ['bookmarks'] })).catch(() => false);
    return { bookmarkConfig: stored.laterOnBookmarkConfig || { enabled: false }, bookmarkPermission: permission === true,
      sources: mode.sources, modeId: mode.id };
  }
  async function preparePersistent() {
    if (!persistent()) return null;
    if (interactive()) return null;
    if (preparing) return preparing;
    const version = generation;
    const task = (async () => {
      const required = await loadPending();
      if (nativeImport) return null;
      if (nativeAt) {
        const facts = (await chrome.storage.local.get('laterOnBookmarkStateMeta')).laterOnBookmarkStateMeta;
        if ((Number(facts?.nativeVerifiedAt) || 0) < nativeAt) { globalThis.LaterOnBookmarkSync?.verify?.(); return null; }
        nativeAt = 0;
      }
      if (!forceBuild) {
        const meta = await globalThis.LaterOnLocalIndex.info();
        // Older schema-5 snapshots remain readable, but need one publication
        // of the Book-only source view before they can skip maintenance.
        if (!dirty && meta?.ready && meta.sourceViews === true && (Number(meta.revision) || 0) >= required && version === generation) {
          thinKnown = meta.thinBookmarks === true; dirty = false; return meta;
        }
      }
      const existing = await globalThis.LaterOnLocalIndex.info();
      const revision = Math.max(required, sourceRevision, (Number(existing?.revision) || 0) + 1, 1);
      sourceRevision = Math.max(sourceRevision, revision);
      dirty = true;
      await marker(() => version === generation ? chrome.storage.local.set({ [PENDING]: { revision, bookmarks: bookmarksChanged, nativeAt, nativeIds: [...nativeIds] } }) : null);
      const boundedSource = typeof globalThis.LaterOnBookmarkSync?.searchSource === 'function';
      const stored = await chrome.storage.local.get(boundedSource ? READING_KEYS : KEYS);
      if (version === generation) liveSource = { items: stored.laterOnItems || [], projects: stored.laterOnProjects || [] };
      if (boundedSource) {
        const bookmarks = await globalThis.LaterOnBookmarkSync.searchSource({ isCurrent: () => version === generation && !interactive() });
        if (!bookmarks) return null;
        stored.laterOnBookmarkSearchState = bookmarks;
      } else if (!stored.laterOnBookmarkSearchState) Object.assign(stored, await chrome.storage.local.get('laterOnBookmarkState'));
      thinKnown = !!stored.laterOnBookmarkSearchState;
      const meta = await globalThis.LaterOnLocalIndex.putSearchSource(stored, revision, () => version === generation && !interactive());
      if (version !== generation) return preparePersistent();
      dirty = false; forceBuild = false; bookmarksChanged = false;
      nativeIds.clear();
      await clearMarker(revision);
      if (version === generation) announce(true);
      return meta;
    })();
    preparing = task;
    try { return await task; }
    catch (error) {
      if (error?.message === 'staleLocalIndex') {
        // Activity may end while the cancelled build unwinds. Its pending
        // source still needs a retry even if catch sees no active dialog.
        if (dirty || forceBuild) scheduleWarm();
        return null;
      }
      if (version !== generation) { if (preparing === task) preparing = null; return preparePersistent(); }
      throw error;
    }
    finally { if (preparing === task) preparing = null; }
  }
  // Foreground recovery uses small, ordinary-priority turns. Full persistent
  // builds keep their background priority; a waiting query must not join them.
  let foregroundAt = 0;
  function foregroundTurn() {
    const clock = () => typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
    if (clock() - foregroundAt < 6) return Promise.resolve();
    const done = () => { foregroundAt = clock(); };
    if (typeof globalThis.scheduler?.postTask === 'function')
      return globalThis.scheduler.postTask(done, { priority: 'user-visible' }).catch(done);
    return new Promise(resolve => setTimeout(() => { done(); resolve(); }, 0));
  }
  // The current Reading library, indexed in memory (a few thousand pages),
  // supplies new or edited saves while the persistent rebuild is running.
  async function liveReading() {
    if (live) return live;
    if (liveReadingTask) return liveReadingTask;
    const version = readingGeneration;
    const task = (async () => {
      if (!liveSource) {
        const stored = await chrome.storage.local.get(['laterOnItems', 'laterOnProjects']);
        if (version !== readingGeneration) return liveReading();
        if (!liveSource) liveSource = { items: stored.laterOnItems || [], projects: stored.laterOnProjects || [] };
      }
      let index;
      try {
        index = await LaterOnQuickSearch.buildAsync({ items: liveSource.items, projects: liveSource.projects }, () => {
          if (version !== readingGeneration) throw Error('staleReadingSource');
          return foregroundTurn();
        });
      } catch (error) {
        if (version !== readingGeneration) return liveReading();
        throw error;
      }
      if (version !== readingGeneration) return liveReading();
      const edited = new Set((liveSource.items || []).filter(item => item?.titleEdited).map(item => webUrl(item.url)).filter(Boolean));
      const value = { index, byUrl: new Map(index.map(entry => [entry.url, entry])), edited };
      live = value;
      return value;
    })();
    liveReadingTask = task;
    try { return await task; } finally { if (liveReadingTask === task) liveReadingTask = null; }
  }
  const bookmarkAllowed = current => current.sources?.includes('bookmarks') !== false && current.bookmarkPermission === true && current.bookmarkConfig?.enabled === true;
  async function nativeNodes(ids) {
    if (!ids.length) return [];
    try { return await chrome.bookmarks.get(ids); }
    catch {
      const found = []; let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
        while (cursor < ids.length) {
          try { const node = (await chrome.bookmarks.get(ids[cursor++]))?.[0]; if (node) found.push(node); } catch {}
        }
      }));
      return found;
    }
  }
  async function nativeIndex(nodes, current, query = '', searchFolders = false) {
    const byId = new Map((nodes || []).filter(Boolean).map(node => [node.id, node]));
    let pending = [...new Set([...byId.values()].map(node => node.parentId).filter(Boolean))];
    const seen = new Set();
    // Read distinct ancestor layers together. Folder names and live scope
    // remain searchable after a move/rename; visible checks never read a tree.
    while (pending.length) {
      const ids = pending.filter(id => !seen.has(id) && !byId.has(id));
      pending.forEach(id => seen.add(id));
      for (let i = 0; i < ids.length; i += 100) for (const node of await nativeNodes(ids.slice(i, i + 100))) byId.set(node.id, node);
      pending = [...new Set([...byId.values()].map(node => node.parentId).filter(id => id && !seen.has(id) && !byId.has(id)))];
    }
    const phrase = String(query || '').trim().toLowerCase();
    if (phrase) {
      const matchesPath = node => {
        for (let current = node, visited = new Set(); current && !visited.has(current.id); current = byId.get(current.parentId)) {
          visited.add(current.id); if ((current.title || '').toLowerCase().includes(phrase)) return true;
        }
        return false;
      };
      const pages = [...byId.values()].filter(node => webUrl(node.url));
      const folders = [...byId.values()].filter(node => !node.url && (nativeIds.has(node.id) || searchFolders) && matchesPath(node)
        && !pages.some(page => page.parentId === node.id)).slice(0, 4);
      let calls = 0;
      for (const folder of folders) {
        const queue = [folder];
        while (queue.length && calls++ < 8) {
          const next = queue.shift(), children = await chrome.bookmarks.getChildren(next.id);
          let added = 0;
          for (const child of children) {
            if (child.url && added++ >= 100) continue;
            if (!child.url && queue.length >= 8) continue;
            byId.set(child.id, child); if (!child.url) queue.push(child);
          }
          if ([...byId.values()].filter(node => node.url).length >= 125) break;
        }
      }
    }
    const inside = node => {
      if (!current.bookmarkConfig.scopeId) return true;
      for (let entry = node, visited = new Set(); entry && !visited.has(entry.id); entry = byId.get(entry.parentId)) {
        if (entry.id === current.bookmarkConfig.scopeId) return true; visited.add(entry.id);
      }
      return false;
    };
    const pages = [...byId.values()].filter(node => webUrl(node.url) && inside(node));
    return LaterOnQuickSearch.build({ bookmarks: { enabled: true, scopeId: current.bookmarkConfig.scopeId || null,
      nodes: pages, folders: [...byId.values()].filter(node => !node.url) }, bookmarkConfig: current.bookmarkConfig });
  }
  async function inScope(node, scopeId, memo) {
    if (!scopeId) return true;
    const chain = [];
    for (let current = node, seen = new Set(); current && !seen.has(current.id); ) {
      if (current.id === scopeId) { chain.forEach(id => memo.set(id, true)); return true; }
      if (memo.has(current.id)) { const value = memo.get(current.id); chain.forEach(id => memo.set(id, value)); return value; }
      seen.add(current.id); chain.push(current.id);
      current = current.parentId ? (await chrome.bookmarks.get(current.parentId))[0] : null;
    }
    chain.forEach(id => memo.set(id, false));
    return false;
  }
  // Native bookmarks answer before any index exists, or while a bookmark
  // change awaits indexing. Scope and permission are checked live.
  async function nativeEntries(query, current, bootstrap = false) {
    if (!bookmarkAllowed(current) || !chrome.bookmarks) return [];
    try {
      const phrase = String(query || '').trim();
      let nodes = await deadline(chrome.bookmarks.getRecent(100), 400);
      if (nativeIds.size) {
        const changed = await nativeNodes([...nativeIds]);
        nodes = [...changed.filter(Boolean), ...(nodes || [])];
      }
      const recent = await nativeIndex((nodes || []).slice(0, 200), current, query);
      if (bootstrap && phrase && !LaterOnQuickSearch.search(recent, phrase).results.length) {
        // Native Chrome search itself can exceed 400 ms at 50k bookmarks.
        // Keep a finite recovery budget without discarding a valid first-use
        // match merely because the disposable index has not been built yet.
        const found = await deadline(chrome.bookmarks.search(phrase), 1500);
        return nativeIndex((found || []).slice(0, 100), current, query, true);
      }
      return recent;
    } catch { return []; }
  }
  async function currentBookmarkEntries(entries, current) {
    if (!bookmarkAllowed(current) || !chrome.bookmarks?.get) return [];
    const ids = [...new Set(entries.flatMap(entry => entry.bookmarkIds || []))].slice(0, 100);
    // A deleted id fails independently; it cannot discard an otherwise valid
    // result page. Only visible candidates are checked, with bounded workers.
    return nativeIndex(await nativeNodes(ids), current);
  }
  function combine(reading, bookmark, edited) {
    if (!bookmark) return reading ? { ...reading } : { readingIds: [], bookmarkIds: [] };
    const base = { ...bookmark, readingIds: [], projectNames: [] };
    if (!reading) return base;
    return { ...base, title: edited || !bookmark.bookmarkIds?.length ? reading.title : bookmark.title,
      source: reading.source || bookmark.source, readingIds: [...reading.readingIds], projectNames: [...reading.projectNames],
      aliases: [...new Set([...(reading.aliases || []), ...(bookmark.aliases || [])])], savedAt: Math.max(reading.savedAt || 0, bookmark.savedAt || 0) };
  }
  // Results usable while the persistent index catches up: the last ready
  // snapshot supplies bookmark identities, the live Reading library supplies
  // current Reading identities, and both are re-ranked with the same rules.
  async function provisional(query, snapshot, current) {
    const reading = current.sources.includes('reading') ? await liveReading() : { index: [], byUrl: new Map(), edited: new Set() };
    const allowBookmarks = bookmarkAllowed(current);
    const merged = new Map();
    const add = (url, bookmark) => {
      const previous = merged.get(url);
      const mark = previous && bookmark ? { ...bookmark, bookmarkIds: [...new Set([...(previous.bookmarkIds || []), ...(bookmark.bookmarkIds || [])])],
        folderNames: [...new Set([...(previous.folderNames || []), ...(bookmark.folderNames || [])])] } : bookmark || (previous?.bookmarkIds?.length ? previous : null);
      const entry = combine(reading.byUrl.get(url), mark && mark.bookmarkIds?.length ? mark : null, reading.edited.has(url));
      if (entry.readingIds.length || entry.bookmarkIds?.length) merged.set(url, entry); else merged.delete(url);
    };
    const snapshotEntries = [...(snapshot?.results || []), ...(snapshot?.lookupEntries || []).map(row => row.entry)];
    const verified = bookmarksChanged ? await currentBookmarkEntries(snapshotEntries, current) : null;
    const verifiedByUrl = verified && new Map(verified.map(entry => [entry.url, entry]));
    for (const entry of snapshotEntries) {
      if (verifiedByUrl && entry.bookmarkIds?.length) {
        const bookmark = verifiedByUrl.get(entry.url);
        if (bookmark || reading.byUrl.has(entry.url)) add(entry.url, bookmark || null);
        continue;
      }
      const bookmark = allowBookmarks && entry.bookmarkIds?.length ? entry : null;
      if (!bookmark && !reading.byUrl.has(entry.url)) continue;
      add(entry.url, bookmark);
    }
    if (verified) for (const entry of verified) if (!merged.has(entry.url)) add(entry.url, entry);
    const readingMatches = LaterOnQuickSearch.search(reading.index, query, { limit: 100 }).results;
    // An edited Reading title may match only the live source, while its older
    // bookmark is outside both this query's snapshot and native recent rows.
    // Recover its published membership by exact identity, not by title search.
    if (allowBookmarks && snapshot && typeof globalThis.LaterOnLocalIndex?.getEntry === 'function') {
      const linked = await Promise.all(readingMatches.filter(entry => !merged.has(entry.url)).map(async entry => {
        const previous = await globalThis.LaterOnLocalIndex.getEntry(entry.id, current).catch(() => null);
        return previous?.url === entry.url && previous.bookmarkIds?.length ? previous : null;
      }));
      const candidates = linked.filter(Boolean);
      const bookmarks = bookmarksChanged ? await currentBookmarkEntries(candidates, current) : candidates;
      for (const entry of bookmarks) if (reading.byUrl.has(entry.url)) add(entry.url, entry);
    }
    for (const entry of readingMatches) if (!merged.has(entry.url)) add(entry.url, null);
    for (const url of current.lookupUrls || []) if (reading.byUrl.has(url) && !merged.has(url)) add(url, null);
    if (!snapshot || allowBookmarks && snapshot.bookmarkVariant !== true || bookmarksChanged)
      for (const entry of await nativeEntries(query, current, !readingMatches.length && !merged.size)) add(entry.url, entry);
    const ranked = LaterOnQuickSearch.search([...merged.values()], query, { limit: 50 });
    const lookupEntries = (current.lookupUrls || []).map(url => merged.get(url)).filter(Boolean).map(entry => {
      const values = LaterOnQuickSearch.fields(entry), hit = LaterOnQuickSearch.matchAll([entry], query)[0];
      return { entry, values, libraryScore: hit ? hit.score : null };
    });
    // The total is a lower bound (the matches known now), never an estimate.
    return { results: ranked.results, total: ranked.total, lookupEntries, sourcesFiltered: true,
      provisional: true, complete: false, revision: snapshot?.revision || 0 };
  }
  async function librarySearch(query, current) {
    if (persistent()) {
      const [snapshot, required] = await Promise.all([globalThis.LaterOnLocalIndex.search(query, current).catch(() => null), loadPending()]);
      // The index returns null when an issued query was superseded. It is
      // not evidence of a missing snapshot and must not force a rebuild.
      if (typeof current.isCurrent === 'function' && !current.isCurrent())
        return { results: [], total: 0, cancelled: true, sourcesFiltered: true };
      const missingBookmarks = bookmarkAllowed(current) && snapshot?.bookmarkVariant !== true;
      if (snapshot?.sourcesFiltered === true && !missingBookmarks && !dirty && (Number(snapshot.revision) || 0) >= required) return snapshot;
      // Never wait for a full rebuild: answer now and announce the fresh
      // commit, which makes open dialogs search again.
      scheduleWarm(!snapshot || snapshot.sourcesFiltered !== true || missingBookmarks);
      if (!snapshot && current.sources.includes('reading') && !String(query || '').trim() && !live && bookmarkAllowed(current)) {
        const reading = liveReading();
        const recent = await nativeEntries('', current);
        if (recent.length && !live) {
          reading.then(() => announce(false)).catch(() => {});
          const ranked = LaterOnQuickSearch.search(recent, '', { limit: 50 });
          return { ...ranked, sourcesFiltered: true, lookupEntries: [], provisional: true, complete: false, revision: 0 };
        }
      }
      return provisional(query, snapshot?.sourcesFiltered === true ? snapshot : null, current);
    }
    const entries = await index(current), ranked = LaterOnQuickSearch.search(entries, query);
    const wanted = new Set(current.lookupUrls || []), byUrl = entries.filter(entry => wanted.has(entry.url));
    return { ...ranked, sourcesFiltered: true, lookupEntries: byUrl.map(entry => ({ entry, values: LaterOnQuickSearch.fields(entry),
      libraryScore: LaterOnQuickSearch.matchAll([entry], query)[0]?.score ?? null })) };
  }
  async function search(query, current, isCurrent = () => true, retry = 0) {
    const hasTabs = current.sources.includes('tabs'), hasLibrary = current.sources.some(source => source !== 'tabs');
    let tabs = hasTabs ? await liveTabs() : { index: [], generation: tabGeneration };
    if (!isCurrent()) return { results: [], total: 0, cancelled: true, sourcesFiltered: true };
    if (!hasLibrary) return { ...LaterOnQuickSearch.search(tabs.index, query), sourcesFiltered: true,
      tabGeneration: tabs.generation, modeId: current.modeId };
    const lookedUp = new Set(tabs.index.map(entry => entry.url));
    const library = await librarySearch(query, { ...current, lookupUrls: hasTabs ? [...lookedUp] : [], isCurrent });
    if (!isCurrent()) return { results: [], total: 0, cancelled: true, sourcesFiltered: true };
    if (!hasTabs) return { ...library, modeId: current.modeId };
    if (tabs.generation !== tabGeneration) {
      tabs = await liveTabs();
      if (tabs.index.some(entry => !lookedUp.has(entry.url)) && retry < 2) return search(query, current, isCurrent, retry + 1);
    }
    if (!isCurrent()) return { results: [], total: 0, cancelled: true, sourcesFiltered: true };
    const tabUrls = new Set(tabs.index.map(entry => entry.url));
    const lookup = (library.lookupEntries || []).filter(row => tabUrls.has(row.entry?.url));
    for (const entry of library.results || []) if (tabUrls.has(entry.url) && !lookedUp.has(entry.url)) {
      lookup.push({ entry, values: LaterOnQuickSearch.fields(entry), libraryScore: entry.score }); lookedUp.add(entry.url);
    }
    const merged = LaterOnQuickSearch.mergeTabs(tabs.index, lookup, current.sources);
    const tabMatches = LaterOnQuickSearch.matchAll(merged, query);
    const duplicateCount = lookup.filter(row => row.libraryScore !== null && row.libraryScore !== undefined).length;
    const disjointLibrary = (library.results || []).filter(entry => !tabUrls.has(entry.url));
    const results = LaterOnQuickSearch.rankScored([...disjointLibrary, ...tabMatches]);
    const unknownUrls = tabs.index.some(entry => !lookedUp.has(entry.url));
    const knownMatches = unknownUrls ? tabMatches.filter(entry => lookedUp.has(entry.url)).length : tabMatches.length;
    // Every displayed library URL outside live tabs is proven disjoint from
    // every matched native URL. This union remains a lower bound even when a
    // continuously arriving URL has not received its library lookup yet.
    const provenUnion = new Set(disjointLibrary.map(entry => entry.url)).size + tabMatches.length;
    const total = Math.max(Math.max(0, library.total - duplicateCount) + knownMatches, provenUnion, results.length);
    return { ...library, results, total, ...(unknownUrls ? { provisional: true, complete: false } : {}),
      tabGeneration: tabs.generation, modeId: current.modeId, sourcesFiltered: true };
  }
  async function options() {
    if (!stylesPromise) stylesPromise = Promise.all(['theme-vars.css', 'quick-switcher.css'].map(async file => {
      const response = await fetch(chrome.runtime.getURL(file));
      if (!response.ok) throw Error('quickSwitcherUnavailable');
      return response.text();
    })).then(([theme, component]) => ({ theme, component })).catch(error => { stylesPromise = null; throw error; });
    const [styles, stored] = await Promise.all([stylesPromise, chrome.storage.local.get('laterOnSettings')]);
    const settings = stored.laterOnSettings || {};
    return { styles, theme: settings.theme || 'light', language: settings.language === 'en' ? 'en' : 'zh-CN', modes: LaterOnQuickModes.normalize(settings.quickSwitcherModes) };
  }
  async function popup(tab, presentation) {
    const url = new URL(popupUrl());
    // The worker already read presentation before choosing the popup. Pass
    // these two enum values so its own page need not wait for a second RPC.
    if (['light', 'dark', 'system'].includes(presentation?.theme)) url.searchParams.set('theme', presentation.theme);
    if (['en', 'zh-CN'].includes(presentation?.language)) url.searchParams.set('language', presentation.language);
    const sourceWindow = await originWindow({ url: tab?.url, tab });
    if (Number.isInteger(sourceWindow)) url.searchParams.set('window', sourceWindow);
    let existing;
    for (const entry of (await chrome.tabs.query({})).filter(entry => isPopup(entry.url))) {
      try { if ((await chrome.windows.get(entry.windowId)).type === 'popup') { existing = entry; break; } } catch {}
    }
    if (existing) {
      await chrome.tabs.update(existing.id, { url: url.href, active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
    let position = {};
    try {
      const source = await chrome.windows.get(sourceWindow);
      if (Number.isFinite(source.left) && Number.isFinite(source.width)) position.left = Math.round(source.left + Math.max(0, (source.width - 700) / 2));
      if (Number.isFinite(source.top)) position.top = Math.round(source.top + 60);
    } catch {}
    await chrome.windows.create({ url: url.href, type: 'popup', focused: true, width: 700, height: 620, ...position });
  }
  async function show(tab) {
    // Preloaded pages already have package styles and sanitized presentation.
    // The trigger therefore needs neither a settings read nor CSS fetches.
    try {
      const message = { type: 'LATERON_QUICK_SWITCHER_SHOW', options: { localPresentation: true, expiresAt: Date.now() + 2400 } };
      const response = await deadline(ownPage(tab.url)
        ? chrome.runtime.sendMessage({ ...message, targetTabId: tab.id })
        : chrome.tabs.sendMessage(tab.id, message));
      if (response?.ok) return;
    } catch {}
    const value = await options();
    // Extension pages carry the same client; already-injected web pages can
    // toggle without reinjection, preserving their current focus ownership.
    try {
      const message = { type: 'LATERON_QUICK_SWITCHER_SHOW', options: { ...value, expiresAt: Date.now() + 2400 } };
      const response = await deadline(ownPage(tab.url)
        ? chrome.runtime.sendMessage({ ...message, targetTabId: tab.id })
        : chrome.tabs.sendMessage(tab.id, message));
      if (response?.ok) return;
    } catch {}
    if (webUrl(tab.url)) {
      try {
        await deadline(chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['quick-switcher-modes.js', 'content-preferences.js', 'picker-keyboard-guard.js', 'quick-switcher-ui.js', 'quick-switcher-client.js'] }));
        const result = await deadline(chrome.scripting.executeScript({ target: { tabId: tab.id },
          func: options => {
            if (Date.now() >= options.expiresAt) return false;
            globalThis.LaterOnQuickSwitcherClient.show(options); return true;
          }, args: [{ ...value, expiresAt: Date.now() + 2400 }] }));
        if (result?.some(entry => entry.result === true)) return;
      } catch { /* Protected pages use the same component in an extension window. */ }
    }
    await popup(tab, value);
  }
  async function open(tab) {
    tab ||= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id) throw Error('quickSwitcherUnavailable');
    if (opening.has(tab.id)) return opening.get(tab.id);
    presentingUntil = Date.now() + 3000;
    const task = show(tab).finally(() => { presentingUntil = 0; opening.delete(tab.id); });
    opening.set(tab.id, task); return task;
  }
  async function originWindow(sender) {
    if (isPopup(sender.url)) {
      const value = Number(new URL(sender.url).searchParams.get('window'));
      if (Number.isInteger(value) && value > 0) {
        try { if ((await chrome.windows.get(value)).type === 'normal') return value; } catch {}
      }
      const normal = (await chrome.windows.getAll({ windowTypes: ['normal'] })).find(window => !window.incognito || sender.tab?.incognito);
      return normal?.id;
    }
    return sender.tab?.windowId;
  }
  async function openResult(message, sender) {
    const current = await context(message.modeId);
    if (typeof message.id === 'string' && message.id.startsWith('tab:')) {
      const match = /^tab:(\d+):(.+)$/.exec(message.id);
      let expected;
      try { expected = match && decodeURIComponent(match[2]); } catch {}
      if (!match || !current.sources.includes('tabs') || !expected || LaterOnQuickSearch.tabUrl(expected) !== expected) throw Error('quickSwitcherMissing');
      let tab;
      try { tab = await chrome.tabs.get(Number(match[1])); } catch { throw Error('quickSwitcherMissing'); }
      if (LaterOnQuickSearch.tabUrl(tab.pendingUrl || tab.url) !== expected || isPopup(expected)) throw Error('quickSwitcherMissing');
      for (let attempt = 0; attempt < 3; attempt++) {
        const modeVersion = modeGeneration, latest = await context(current.modeId);
        if (modeVersion !== modeGeneration) continue;
        if (!latest.sources.includes('tabs')) throw Error('quickSwitcherMissing');
        const nativeVersion = tabGeneration;
        tab = await chrome.tabs.get(Number(match[1])).catch(() => null);
        if (nativeVersion !== tabGeneration || modeVersion !== modeGeneration) continue;
        if (!tab || LaterOnQuickSearch.tabUrl(tab.pendingUrl || tab.url) !== expected) throw Error('quickSwitcherMissing');
        await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true });
        activeClients.delete(clientKey(sender)); if (dirty || forceBuild) resumeWarm();
        return { reused: true, source: 'tabs' };
      }
      throw Error('quickSwitcherMissing');
    }
    if (typeof message.id !== 'string' || !message.id.startsWith('page:')) throw Error('quickSwitcherMissing');
    const url = webUrl(message.id.slice(5));
    if (!url || url !== message.id.slice(5)) throw Error('quickSwitcherMissing');
    // Recheck membership and permission after a result click, including when a
    // background restart or a scope change happened while the dialog was open.
    // Current Reading items and native bookmarks decide; an index rebuild is
    // never awaited, so a page saved a moment ago opens immediately.
    const version = generation;
    let readingVersion = readingGeneration, readingSource = liveSource;
    const hasLibrary = current.sources.some(source => source !== 'tabs');
    const [required, metadata, tabs] = await Promise.all([
      persistent() && hasLibrary ? loadPending() : 0,
      persistent() && hasLibrary ? globalThis.LaterOnLocalIndex.info().catch(() => null) : null,
      message.newTab === true && !current.sources.includes('tabs') ? [] : chrome.tabs.query({})
    ]);
    const known = hasLibrary ? persistent() ? await globalThis.LaterOnLocalIndex.getEntry(message.id, current).catch(() => null)
      : (await index(current)).find(entry => entry.id === message.id) : null;
    let readingIds;
    if (!current.sources.includes('reading')) readingIds = [];
    else if (persistent() && known && !dirty && version === generation && metadata?.ready && (Number(metadata.revision) || 0) >= required) {
      // Current publication already proves Reading membership. Copying the
      // whole library before opening one result defeats the bounded index.
      readingIds = [...(known.readingIds || [])];
    } else if (liveSource) {
      readingIds = liveSource.items.filter(item => item && webUrl(item.url) === url).map(item => String(item.id));
    } else {
      const stored = await chrome.storage.local.get('laterOnItems');
      const items = liveSource?.items || stored.laterOnItems || [];
      readingIds = items.filter(item => item && webUrl(item.url) === url).map(item => String(item.id));
    }
    const entry = { id: message.id, url, readingIds,
      bookmarkIds: current.sources.includes('bookmarks') ? [...(known?.bookmarkIds || [])] : [] };
    let libraryAllowed = !!entry.readingIds.length || await nativeBookmarkExists(entry, current);
    if (!libraryAllowed && current.sources.includes('bookmarks')) {
      let found = [];
      try { found = (await chrome.bookmarks?.search?.({ url })) || []; } catch {}
      entry.bookmarkIds = found.filter(node => webUrl(node?.url) === url).map(node => node.id).filter(id => !entry.bookmarkIds.includes(id));
      libraryAllowed = !!entry.bookmarkIds.length && await nativeBookmarkExists(entry, current);
    }
    const windowId = await originWindow(sender);
    const matches = tabs.filter(tab => webUrl(tab.pendingUrl || tab.url) === entry.url);
    let existing = matches.find(tab => tab.windowId === windowId && tab.active)
      || matches.find(tab => tab.windowId === windowId) || matches[0];
    const modeVersion = modeGeneration, latest = await context(current.modeId);
    if (JSON.stringify(latest.sources) !== JSON.stringify(current.sources)) throw Error('quickSwitcherMissing');
    const readingChanged = () => current.sources.includes('reading')
      && (readingVersion !== readingGeneration || readingSource !== liveSource);
    let readingMembershipLost = false, recoveredBookmark = false;
    async function refreshReadingProof() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const value = readingGeneration, source = liveSource;
        const items = source?.items || (await chrome.storage.local.get('laterOnItems')).laterOnItems || [];
        if (value !== readingGeneration || source !== liveSource) continue;
        const ids = items.filter(item => item && webUrl(item.url) === url).map(item => String(item.id));
        if (entry.readingIds.length && !ids.length) readingMembershipLost = true;
        entry.readingIds = ids;
        readingVersion = value; readingSource = source; return;
      }
      throw Error('quickSwitcherMissing');
    }
    let proven = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (modeVersion !== modeGeneration) throw Error('quickSwitcherMissing');
      if (current.sources.includes('reading') && readingChanged()) await refreshReadingProof();
      const readingAllowed = !!entry.readingIds.length;
      let bookmarkAllowedNow = !readingAllowed && await nativeBookmarkExists(entry, latest);
      if (!readingAllowed && !bookmarkAllowedNow && current.sources.includes('bookmarks') && readingMembershipLost && !recoveredBookmark) {
        recoveredBookmark = true;
        let found = [];
        try { found = await chrome.bookmarks?.search?.({ url }) || []; } catch {}
        entry.bookmarkIds = found.filter(node => webUrl(node?.url) === url).map(node => node.id);
        bookmarkAllowedNow = await nativeBookmarkExists(entry, latest);
      }
      const bookVersion = generation, bookPermission = permissionGeneration;
      libraryAllowed = readingAllowed || bookmarkAllowedNow;
      const nativeVersion = tabGeneration;
      if (existing && (message.newTab !== true || !libraryAllowed)) {
        const fresh = typeof chrome.tabs.get === 'function' ? await chrome.tabs.get(existing.id).catch(() => null)
          : (await chrome.tabs.query({})).find(tab => tab.id === existing.id);
        if (nativeVersion !== tabGeneration) continue;
        existing = fresh && webUrl(fresh.pendingUrl || fresh.url) === entry.url ? fresh : null;
      }
      if (readingChanged() || modeVersion !== modeGeneration) continue;
      if (bookmarkAllowedNow && (bookVersion !== generation || bookPermission !== permissionGeneration)) continue;
      proven = true; break;
    }
    if (!proven) throw Error('quickSwitcherMissing');
    if (!libraryAllowed && !(current.sources.includes('tabs') && existing)) throw Error('quickSwitcherMissing');
    if (message.newTab === true && libraryAllowed) existing = null;
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else if (isPopup(sender.url) && !Number.isInteger(windowId)) {
      await chrome.windows.create({ url: entry.url, type: 'normal', focused: true });
    } else {
      const created = await chrome.tabs.create({ url: entry.url, active: true, ...(Number.isInteger(windowId) ? { windowId } : {}) });
      if (created.windowId != null) await chrome.windows.update(created.windowId, { focused: true });
    }
    if (entry.readingIds.length && !readingChanged() && modeVersion === modeGeneration) {
      try { Promise.resolve(chrome.storage.local.set({ laterOnCurrentItem: entry.readingIds[0] })).catch(() => {}); } catch {}
    }
    activeClients.delete(clientKey(sender));
    if (dirty || forceBuild) resumeWarm();
    return { reused: !!existing };
  }
  async function nativeBookmarkExists(entry, current) {
    if (!current?.sources.includes('bookmarks')) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const version = generation, permission = permissionGeneration;
      const config = (await chrome.storage.local.get('laterOnBookmarkConfig')).laterOnBookmarkConfig;
      let found = false;
      if (config?.enabled && await chrome.permissions.contains({ permissions: ['bookmarks'] })) for (const id of entry.bookmarkIds) {
        try {
          let node = (await chrome.bookmarks.get(id))[0];
          if (webUrl(node?.url) !== entry.url) continue;
          const seen = new Set();
          while (node && !seen.has(node.id)) {
            if (!config.scopeId || node.id === config.scopeId) { found = true; break; }
            seen.add(node.id); node = node.parentId ? (await chrome.bookmarks.get(node.parentId))[0] : null;
          }
          if (found) break;
        } catch { /* Native deletion/move can precede publication of its cache. */ }
      }
      if (version === generation && permission === permissionGeneration) return found;
    }
    return false;
  }
  async function closePopup(message, sender) {
    let tab = sender.tab;
    if (!tab && Number.isInteger(message.tabId)) {
      try { tab = await chrome.tabs.get(message.tabId); } catch {}
    }
    if (!tab?.id || !isPopup(tab.url) || tab.url !== sender.url) return {};
    const window = await chrome.windows.get(tab.windowId);
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    if (window.type === 'popup' && tabs.length === 1 && tabs[0].id === tab.id) await chrome.windows.remove(tab.windowId);
    else await chrome.tabs.remove(tab.id);
    return {};
  }
  async function handle(message, sender) {
    if (!allowed(sender)) throw Error('quickSwitcherUnavailable');
    if (message.type === 'QUICK_SWITCHER_ACTIVITY') {
      const key = clientKey(sender);
      if (message.active === true) activeClients.set(key, { at: Date.now(), tabId: sender.tab?.id, windowId: sender.tab?.windowId });
      else { activeClients.delete(key); resumeWarm(); }
      return {};
    }
    if (message.type === 'QUICK_SWITCHER_SHOW') { await open(sender.tab); return {}; }
    if (message.type === 'QUICK_SWITCHER_CONTEXT') return { options: await options() };
    if (message.type === 'QUICK_SWITCHER_SEARCH') {
      // A live client query also renews activity after a worker restart. The
      // flag is emitted only by an open UI, so quiet diagnostics stay quiet.
      if (message.active === true) activeClients.set(clientKey(sender), { at: Date.now(), tabId: sender.tab?.id, windowId: sender.tab?.windowId });
      const key = clientKey(sender), sequence = (queries.get(key) || 0) + 1, modeVersion = modeGeneration;
      const sourceVersion = generation, permissionVersion = permissionGeneration;
      queries.set(key, sequence);
      const current = await context(message.modeId);
      const value = await search(String(message.query || '').slice(0, 500), current,
        () => queries.get(key) === sequence && modeVersion === modeGeneration
          && (!current.sources.some(source => source !== 'tabs') || sourceVersion === generation)
          && (!current.sources.includes('bookmarks') || permissionVersion === permissionGeneration));
      const { lookupEntries, ...reply } = value;
      return reply;
    }
    if (message.type === 'QUICK_SWITCHER_OPEN') return openResult(message, sender);
    if (message.type === 'QUICK_SWITCHER_LEGACY_STATUS') {
      const settings = (await chrome.storage.local.get('laterOnSettings')).laterOnSettings || {};
      const commands = await chrome.commands.getAll();
      return { enabled: settings.windowShortcutFallback !== false && !commands.find(command => command.name === 'save-window-tabs')?.shortcut };
    }
    if (message.type === 'QUICK_SWITCHER_CLOSE' && isPopup(sender.url)) {
      return closePopup(message, sender);
    }
    if (message.type === 'QUICK_SWITCHER_LEGACY_WINDOW') {
      const settings = (await chrome.storage.local.get('laterOnSettings')).laterOnSettings || {};
      if (settings.windowShortcutFallback === false) return {};
      const commands = await chrome.commands.getAll();
      if (commands.find(command => command.name === 'save-window-tabs')?.shortcut) return {};
      await saveAllTabsInWindow('shortcut', sender.tab); return {};
    }
    throw Error('quickSwitcherUnavailable');
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith('QUICK_SWITCHER_')) return;
    handle(message, sender).then(value => respond({ ok: true, ...value }), error => respond({ ok: false, error: error?.message || 'quickSwitcherUnavailable' }));
    return true;
  });
  globalThis.LaterOnQuickSwitcher = { open, handle, prepare: preparePersistent, isInteractive: interactive,
    bookmarksReady: () => { if (dirty || forceBuild) scheduleWarm(); } };
  // onInstalled passes a details object. It is not a request to force a full
  // rebuild: an unchanged, current index remains valid across folder reloads.
  chrome.runtime.onInstalled?.addListener(() => scheduleWarm());
  chrome.runtime.onStartup?.addListener(() => scheduleWarm());
})();

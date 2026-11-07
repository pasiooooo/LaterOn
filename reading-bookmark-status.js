// A device-local hint for reading items. The native bookmark cache remains the
// authority; membership never becomes a property of a reading item or backup.
(() => {
  const CONFIG = 'laterOnBookmarkConfig', STATE = 'laterOnBookmarkState', META = 'laterOnBookmarkStateMeta';
  const BADGE = 'reading-bookmark-status';
  let config = null, state = null, urls = new Set();
  let allowed = !globalThis.chrome?.permissions?.contains;
  let configVersion = 0, stateVersion = 0, permissionVersion = 0;

  // Match the native bookmark adapter's URL serialization. Reading-item
  // normalization intentionally drops fragments and tracking parameters, which
  // would incorrectly identify distinct browser bookmarks as the same page.
  function urlKey(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function label() {
    const translated = window.LaterOnI18n?.t?.('alreadyInBookmarks');
    return translated && translated !== 'alreadyInBookmarks' ? translated
      : document.documentElement.lang === 'en' ? 'Already in Bookmarks' : '已在书签库中';
  }
  // Pages with the device-local index ask only about the URLs they display.
  // Without it (older hosts), the cached mirror is read as before.
  const bounded = !!globalThis.LaterOnLocalIndex;
  let meta = null, metaVersion = 0, generation = 0, flushTimer = null, startup = null;
  const known = new Map(), pending = new Set();
  const usable = () => allowed && config?.enabled === true && meta?.enabled === true && !meta.error
    && (config.scopeId || null) === (meta.scopeId || null);
  const member = key => bounded ? usable() && known.get(key) === true : urls.has(key);
  function updateBadge(badge) {
    const present = member(badge.dataset.bookmarkUrl);
    if (bounded && usable() && badge.dataset.bookmarkUrl && !known.has(badge.dataset.bookmarkUrl)) request(badge.dataset.bookmarkUrl);
    badge.hidden = !present;
    badge.parentElement?.classList.toggle('has-bookmark-status', present);
    const text = label();
    if (badge.title !== text) badge.title = text;
    if (badge.getAttribute('aria-label') !== text) badge.setAttribute('aria-label', text);
  }
  function refreshBadges() {
    document.querySelectorAll(`.${BADGE}`).forEach(updateBadge);
  }
  function request(key) {
    pending.add(key);
    if (!flushTimer && !startup) flushTimer = setTimeout(flush, 0);
  }
  async function lookup(keys) {
    const local = globalThis.LaterOnLocalIndex;
    try {
      const result = await local?.membership?.(keys, { bookmarkPermission: allowed, bookmarkConfig: config });
      if (result && Array.isArray(result.matches) && meta?.updatedAt && result.updatedAt === meta.updatedAt) return result.matches;
    } catch {}
    const response = await chrome.runtime.sendMessage({ type: 'BOOKMARKS_MEMBERSHIP', urls: keys });
    if (!response?.ok || response.state?.valid !== true) return [];
    return response.state.matches || [];
  }
  async function flush() {
    flushTimer = null;
    while (pending.size) {
      const keys = [...pending].slice(0, 200), run = generation;
      keys.forEach(key => pending.delete(key));
      if (!usable()) continue;
      let matches = [];
      try { matches = await lookup(keys); } catch { continue; }
      if (run !== generation) { keys.forEach(key => pending.add(key)); continue; }
      const found = new Set(matches);
      for (const key of keys) known.set(key, found.has(key));
      refreshBadges();
    }
  }
  function requery() {
    generation++;
    for (const badge of document.querySelectorAll(`.${BADGE}`)) if (badge.dataset.bookmarkUrl) pending.add(badge.dataset.bookmarkUrl);
    for (const key of known.keys()) pending.add(key);
    known.clear();
    refreshBadges();
    if (pending.size && !flushTimer && !startup) flushTimer = setTimeout(flush, 0);
  }
  function rebuild() {
    if (bounded) { refreshBadges(); return; }
    urls = new Set();
    if (allowed && config?.enabled === true && state?.enabled === true && !state.error
      && (config.scopeId || null) === (state.scopeId || null)) {
      for (const node of Array.isArray(state.nodes) ? state.nodes : []) {
        const key = urlKey(node.url);
        if (key) urls.add(key);
      }
    }
    refreshBadges();
  }
  function attach(container, url) {
    if (!container) return null;
    let badge = container.querySelector(`.${BADGE}`);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = BADGE;
      badge.setAttribute('role', 'img');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', 'M6 3h12v18l-6-4-6 4z');
      svg.append(path); badge.append(svg); container.append(badge);
    }
    badge.dataset.bookmarkUrl = urlKey(url);
    updateBadge(badge);
    return badge;
  }
  if (!bounded) chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || (!changes[CONFIG] && !changes[STATE])) return;
    if (changes[CONFIG]) {
      configVersion++;
      const next = changes[CONFIG].newValue || null;
      if (next?.enabled !== config?.enabled || (next?.scopeId || null) !== (config?.scopeId || null)) { state = null; stateVersion++; }
      config = next;
    }
    if (changes[STATE]) { stateVersion++; state = changes[STATE].newValue || null; }
    rebuild();
  });
  if (bounded) {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || (!changes[CONFIG] && !changes[META])) return;
      let changed = false;
      if (changes[CONFIG]) { configVersion++; config = changes[CONFIG].newValue || null; changed = true; }
      if (changes[META]) {
        metaVersion++;
        const next = changes[META].newValue || null;
        changed ||= next?.signature !== meta?.signature || next?.scopeId !== meta?.scopeId;
        meta = next;
      }
      if (changed) requery(); else refreshBadges();
    });
  }
  function relevantPermission(change) {
    return !Array.isArray(change?.permissions) || change.permissions.includes('bookmarks');
  }
  async function checkPermission() {
    const version = ++permissionVersion;
    let granted = false;
    try { granted = await chrome.permissions.contains({ permissions: ['bookmarks'] }); } catch {}
    if (version !== permissionVersion) return;
    const before = allowed;
    allowed = granted === true;
    if (bounded && before !== allowed) requery(); else rebuild();
  }
  chrome.permissions?.onRemoved?.addListener(change => {
    if (!relevantPermission(change)) return;
    permissionVersion++;
    allowed = false; state = null; generation++; known.clear(); rebuild();
  });
  chrome.permissions?.onAdded?.addListener(change => {
    if (relevantPermission(change)) checkPermission();
  });
  window.addEventListener('lateron-language-change', refreshBadges);
  const ready = startup = (async () => {
    const configReadVersion = configVersion, stateReadVersion = stateVersion, metaReadVersion = metaVersion;
    let stored = {};
    try { stored = await chrome.storage.local.get(bounded ? [CONFIG, META] : [CONFIG, STATE]); } catch {}
    if (configReadVersion === configVersion) config = stored[CONFIG] || null;
    if (bounded) { if (metaReadVersion === metaVersion) meta = stored[META] || null; }
    else if (stateReadVersion === stateVersion) state = stored[STATE] || null;
    if (chrome.permissions?.contains) await checkPermission();
    else rebuild();
    if (bounded) {
      startup = null;
      for (const badge of document.querySelectorAll(`.${BADGE}`)) if (badge.dataset.bookmarkUrl && !known.has(badge.dataset.bookmarkUrl)) pending.add(badge.dataset.bookmarkUrl);
      await flush();
    }
    await window.LaterOnI18n?.ready;
    refreshBadges();
  })();
  window.LaterOnReadingBookmarkStatus = { attach, has: url => member(urlKey(url)), urlKey, ready };
})();

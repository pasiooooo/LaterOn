// A device-local hint for reading items. The native bookmark cache remains the
// authority; membership never becomes a property of a reading item or backup.
(() => {
  const CONFIG = 'laterOnBookmarkConfig', STATE = 'laterOnBookmarkState';
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
  function updateBadge(badge) {
    const present = urls.has(badge.dataset.bookmarkUrl);
    badge.hidden = !present;
    badge.parentElement?.classList.toggle('has-bookmark-status', present);
    const text = label();
    if (badge.title !== text) badge.title = text;
    if (badge.getAttribute('aria-label') !== text) badge.setAttribute('aria-label', text);
  }
  function refreshBadges() {
    document.querySelectorAll(`.${BADGE}`).forEach(updateBadge);
  }
  function rebuild() {
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
  chrome.storage?.onChanged?.addListener((changes, area) => {
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
  function relevantPermission(change) {
    return !Array.isArray(change?.permissions) || change.permissions.includes('bookmarks');
  }
  async function checkPermission() {
    const version = ++permissionVersion;
    let granted = false;
    try { granted = await chrome.permissions.contains({ permissions: ['bookmarks'] }); } catch {}
    if (version !== permissionVersion) return;
    allowed = granted === true;
    rebuild();
  }
  chrome.permissions?.onRemoved?.addListener(change => {
    if (!relevantPermission(change)) return;
    permissionVersion++;
    allowed = false; state = null; rebuild();
  });
  chrome.permissions?.onAdded?.addListener(change => {
    if (relevantPermission(change)) checkPermission();
  });
  window.addEventListener('lateron-language-change', refreshBadges);
  const ready = (async () => {
    const configReadVersion = configVersion, stateReadVersion = stateVersion;
    let stored = {};
    try { stored = await chrome.storage.local.get([CONFIG, STATE]); } catch {}
    if (configReadVersion === configVersion) config = stored[CONFIG] || null;
    if (stateReadVersion === stateVersion) state = stored[STATE] || null;
    if (chrome.permissions?.contains) await checkPermission();
    else rebuild();
    await window.LaterOnI18n?.ready;
    refreshBadges();
  })();
  window.LaterOnReadingBookmarkStatus = { attach, has: url => urls.has(urlKey(url)), urlKey, ready };
})();

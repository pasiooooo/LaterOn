(() => {
  if (globalThis.LaterOnQuickSwitcherClient?.runtime === chrome.runtime) return;
  const popup = location.href.split('?')[0] === chrome.runtime.getURL('quick-switcher.html');
  const ownPage = location.href.startsWith(chrome.runtime.getURL(''));
  let active = null;
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw Error(response?.error || 'quickSwitcherUnavailable');
    return response;
  }
  function show(options) {
    if (options?.expiresAt && Date.now() >= options.expiresAt) return null;
    if (options?.localPresentation) {
      const styles = globalThis.LaterOnQuickSwitcherStyles;
      const presentation = globalThis.LaterOnContentPreferences?.value;
      const local = ownPage ? pageOptions() : styles && presentation ? { styles, theme: presentation.theme, language: presentation.language } : null;
      if (!local) return false;
      options = { ...local, expiresAt: options.expiresAt };
    }
    if (globalThis.LaterOnQuickSwitcherUI.active) { globalThis.LaterOnQuickSwitcherUI.close(); return; }
    active = globalThis.LaterOnQuickSwitcherUI.open({ ...options,
      search: query => localSearch(query),
      onOpen: (result, options) => send({ type: 'QUICK_SWITCHER_OPEN', id: result.id, newTab: options?.newTab === true }),
      onClose() {
        active = null;
        send({ type: 'QUICK_SWITCHER_ACTIVITY', active: false }).catch(() => {});
        if (popup) {
          Promise.resolve().then(() => chrome.tabs?.getCurrent?.()).then(tab => chrome.runtime.sendMessage({ type: 'QUICK_SWITCHER_CLOSE', tabId: tab?.id })).catch(() => {});
        }
      }
    });
    send({ type: 'QUICK_SWITCHER_ACTIVITY', active: true }).catch(() => {});
    return active;
  }
  window.addEventListener('pagehide', () => {
    if (active) send({ type: 'QUICK_SWITCHER_ACTIVITY', active: false }).catch(() => {});
  });
  async function localSearch(query) {
    // Extension surfaces can read their prepared index directly. A dormant
    // service worker need not wake just to display the first result slice.
    if (ownPage && globalThis.LaterOnLocalIndex?.supported?.() && globalThis.LaterOnQuickSearch) {
      try {
        const [stored, bookmarkPermission] = await Promise.all([chrome.storage.local.get(['laterOnBookmarkConfig', 'laterOnQuickSearchPending']),
          chrome.permissions?.contains({ permissions: ['bookmarks'] })]);
        const result = await globalThis.LaterOnLocalIndex.search(query, { bookmarkConfig: stored.laterOnBookmarkConfig, bookmarkPermission });
        // A pending source revision means the prepared snapshot is behind the
        // libraries; the worker merges current Reading and native bookmarks.
        const needsBookmarks = bookmarkPermission === true && stored.laterOnBookmarkConfig?.enabled === true;
        if (result && !(needsBookmarks && result.bookmarkVariant !== true) && !stored.laterOnQuickSearchPending?.revision) return result;
      } catch {}
    }
    return send({ type: 'QUICK_SWITCHER_SEARCH', query, active: !!active });
  }
  function pageOptions() {
    try {
      const styles = {};
      for (const [key, file] of [['theme', 'theme-vars.css'], ['component', 'quick-switcher.css']]) {
        const sheet = [...document.styleSheets].find(value => value.href === chrome.runtime.getURL(file));
        if (!sheet) return null;
        styles[key] = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
      }
      return { styles, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
        language: document.documentElement.lang === 'en' ? 'en' : 'zh-CN' };
    } catch { return null; }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'LATERON_QUICK_SWITCHER_CHANGED') { active?.refresh?.(); return; }
    if (message?.type !== 'LATERON_QUICK_SWITCHER_SHOW') return;
    const display = () => {
      if (message.options?.expiresAt && Date.now() >= message.options.expiresAt) { respond({ ok: false }); return; }
      try { respond({ ok: show(message.options) !== false }); }
      catch { respond({ ok: false }); }
    };
    if (Number.isInteger(message.targetTabId)) {
      Promise.resolve().then(() => chrome.tabs?.getCurrent?.()).then(tab => {
        if (tab?.id === message.targetTabId && globalThis.LaterOnSidepanelSwitch?.isActive?.() !== false) display();
      }).catch(() => {});
      return true;
    }
    display();
  });
  if (ownPage || !globalThis.LaterOnContentPreferences) chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ['laterOnItems', 'laterOnProjects', 'laterOnBookmarkConfig', 'laterOnBookmarkSearchState', 'laterOnQuickSearchPending',
      ...(!globalThis.LaterOnContentPreferences ? ['laterOnBookmarkState'] : [])].some(key => changes[key])) active?.refresh?.();
  });
  document.addEventListener('click', event => {
    if (!ownPage || globalThis.LaterOnSidepanelSwitch?.isActive?.() === false) return;
    if (!event.target.closest?.('[data-quick-switcher]')) return;
    const options = pageOptions();
    if (options) { show(options); return; }
    send({ type: 'QUICK_SWITCHER_SHOW' }).catch(() => {});
  });
  globalThis.LaterOnQuickSwitcherClient = { show, runtime: chrome.runtime };
  if (popup) {
    // These same-origin styles have already loaded before this deferred
    // script executes. Reuse them in the shared shadow component and make
    // its search field available while the worker prepares search results.
    let options;
    try {
      const styles = {};
      for (const [key, file] of [['theme', 'theme-vars.css'], ['component', 'quick-switcher.css']]) {
        const sheet = [...document.styleSheets].find(value => value.href === chrome.runtime.getURL(file));
        if (!sheet) throw Error('missing style');
        styles[key] = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
      }
      const params = new URL(location.href).searchParams;
      const presentation = { theme: params.get('theme'), language: params.get('language') };
      if (!['light', 'dark', 'system'].includes(presentation.theme) || !['en', 'zh-CN'].includes(presentation.language)) throw Error('missing presentation');
      options = { ...presentation, styles };
    } catch {}
    if (options) show(options);
    else send({ type: 'QUICK_SWITCHER_CONTEXT' }).then(response => show(response.options)).catch(() => {
      const error = document.querySelector('#quickSwitcherError');
      if (error) error.hidden = false;
    });
  }
})();

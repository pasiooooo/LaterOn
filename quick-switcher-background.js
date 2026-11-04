// Search stays in the extension worker: pages receive only the current result
// slice, never covers, the bookmark tree or the full reading library.
(() => {
  const KEYS = ['laterOnItems', 'laterOnProjects', 'laterOnBookmarkState', 'laterOnBookmarkConfig'];
  const popupUrl = () => chrome.runtime.getURL('quick-switcher.html');
  let generation = 0, cached = null, building = null, stylesPromise = null;
  const opening = new Map();
  const invalidate = () => { generation++; cached = null; building = null; };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEYS.some(key => changes[key])) invalidate();
  });
  chrome.permissions?.onRemoved?.addListener(invalidate);
  chrome.permissions?.onAdded?.addListener(invalidate);
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
  async function index() {
    if (cached) return cached;
    if (building) return building;
    const version = generation;
    const task = (async () => {
      const stored = await chrome.storage.local.get(KEYS);
      let permission = false;
      try { permission = await chrome.permissions?.contains({ permissions: ['bookmarks'] }); } catch {}
      const value = LaterOnQuickSearch.build({ items: stored.laterOnItems, projects: stored.laterOnProjects,
        bookmarks: stored.laterOnBookmarkState,
        bookmarkConfig: permission ? stored.laterOnBookmarkConfig : { enabled: false } });
      if (version !== generation) return index();
      cached = value;
      return value;
    })();
    building = task;
    try { return await task; } finally { if (building === task) building = null; }
  }
  async function options() {
    if (!stylesPromise) stylesPromise = Promise.all(['theme-vars.css', 'quick-switcher.css'].map(async file => {
      const response = await fetch(chrome.runtime.getURL(file));
      if (!response.ok) throw Error('quickSwitcherUnavailable');
      return response.text();
    })).then(([theme, component]) => ({ theme, component })).catch(error => { stylesPromise = null; throw error; });
    const [styles, stored] = await Promise.all([stylesPromise, chrome.storage.local.get('laterOnSettings')]);
    const settings = stored.laterOnSettings || {};
    return { styles, theme: settings.theme || 'light', language: settings.language === 'en' ? 'en' : 'zh-CN' };
  }
  async function popup(tab) {
    const url = new URL(popupUrl());
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
        await deadline(chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker-keyboard-guard.js', 'quick-switcher-ui.js', 'quick-switcher-client.js'] }));
        const result = await deadline(chrome.scripting.executeScript({ target: { tabId: tab.id },
          func: options => {
            if (Date.now() >= options.expiresAt) return false;
            globalThis.LaterOnQuickSwitcherClient.show(options); return true;
          }, args: [{ ...value, expiresAt: Date.now() + 2400 }] }));
        if (result?.some(entry => entry.result === true)) return;
      } catch { /* Protected pages use the same component in an extension window. */ }
    }
    await popup(tab);
  }
  async function open(tab) {
    tab ||= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id) throw Error('quickSwitcherUnavailable');
    if (opening.has(tab.id)) return opening.get(tab.id);
    const task = show(tab).finally(() => opening.delete(tab.id));
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
    if (typeof message.id !== 'string') throw Error('quickSwitcherMissing');
    // Recheck membership and permission after a result click, including when a
    // background restart or a scope change happened while the dialog was open.
    invalidate();
    const entry = (await index()).find(entry => entry.id === message.id);
    if (!entry || !webUrl(entry.url)) throw Error('quickSwitcherMissing');
    if (!entry.readingIds.length && !await nativeBookmarkExists(entry)) throw Error('quickSwitcherMissing');
    const windowId = await originWindow(sender);
    const tabs = message.newTab === true ? [] : await chrome.tabs.query({});
    const matches = tabs.filter(tab => webUrl(tab.pendingUrl || tab.url) === entry.url);
    const existing = matches.find(tab => tab.windowId === windowId && tab.active)
      || matches.find(tab => tab.windowId === windowId) || matches[0];
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else if (isPopup(sender.url) && !Number.isInteger(windowId)) {
      await chrome.windows.create({ url: entry.url, type: 'normal', focused: true });
    } else {
      const created = await chrome.tabs.create({ url: entry.url, active: true, ...(Number.isInteger(windowId) ? { windowId } : {}) });
      if (created.windowId != null) await chrome.windows.update(created.windowId, { focused: true });
    }
    if (entry.readingIds.length) {
      try { await chrome.storage.local.set({ laterOnCurrentItem: entry.readingIds[0] }); } catch {}
    }
    return { reused: !!existing };
  }
  async function nativeBookmarkExists(entry) {
    const config = (await chrome.storage.local.get('laterOnBookmarkConfig')).laterOnBookmarkConfig;
    if (!config?.enabled || !await chrome.permissions.contains({ permissions: ['bookmarks'] })) return false;
    for (const id of entry.bookmarkIds) {
      try {
        let node = (await chrome.bookmarks.get(id))[0];
        if (webUrl(node?.url) !== entry.url) continue;
        const seen = new Set();
        while (node && !seen.has(node.id)) {
          if (!config.scopeId || node.id === config.scopeId) return true;
          seen.add(node.id);
          node = node.parentId ? (await chrome.bookmarks.get(node.parentId))[0] : null;
        }
      } catch { /* Native deletion/move can precede publication of its cache. */ }
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
    if (message.type === 'QUICK_SWITCHER_SHOW') { await open(sender.tab); return {}; }
    if (message.type === 'QUICK_SWITCHER_CONTEXT') return { options: await options() };
    if (message.type === 'QUICK_SWITCHER_SEARCH') return LaterOnQuickSearch.search(await index(), String(message.query || '').slice(0, 500));
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
  globalThis.LaterOnQuickSwitcher = { open, handle };
})();

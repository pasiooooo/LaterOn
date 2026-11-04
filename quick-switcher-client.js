(() => {
  if (globalThis.LaterOnQuickSwitcherClient) return;
  const popup = location.href.split('?')[0] === chrome.runtime.getURL('quick-switcher.html');
  let active = null;
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw Error(response?.error || 'quickSwitcherUnavailable');
    return response;
  }
  function show(options) {
    if (options?.expiresAt && Date.now() >= options.expiresAt) return null;
    if (globalThis.LaterOnQuickSwitcherUI.active) { globalThis.LaterOnQuickSwitcherUI.close(); return; }
    active = globalThis.LaterOnQuickSwitcherUI.open({ ...options,
      search: query => send({ type: 'QUICK_SWITCHER_SEARCH', query }),
      onOpen: (result, options) => send({ type: 'QUICK_SWITCHER_OPEN', id: result.id, newTab: options?.newTab === true }),
      onClose() {
        active = null;
        if (popup) {
          Promise.resolve().then(() => chrome.tabs?.getCurrent?.()).then(tab => chrome.runtime.sendMessage({ type: 'QUICK_SWITCHER_CLOSE', tabId: tab?.id })).catch(() => {});
        }
      }
    });
    return active;
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'LATERON_QUICK_SWITCHER_SHOW') return;
    const display = () => {
      if (message.options?.expiresAt && Date.now() >= message.options.expiresAt) { respond({ ok: false }); return; }
      try { show(message.options); respond({ ok: true }); }
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
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ['laterOnItems', 'laterOnProjects', 'laterOnBookmarkConfig', 'laterOnBookmarkState'].some(key => changes[key])) active?.refresh?.();
  });
  document.addEventListener('click', event => {
    if (!location.href.startsWith(chrome.runtime.getURL(''))) return;
    if (!event.target.closest?.('[data-quick-switcher]')) return;
    send({ type: 'QUICK_SWITCHER_SHOW' }).catch(() => {});
  });
  globalThis.LaterOnQuickSwitcherClient = { show };
  if (popup) send({ type: 'QUICK_SWITCHER_CONTEXT' }).then(response => show(response.options)).catch(() => {
    const error = document.querySelector('#quickSwitcherError');
    if (error) error.hidden = false;
  });
})();

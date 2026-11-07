// Only presentation enums and shortcut eligibility cross into web frames.
// Bookmark trees, images and service credentials never enter these messages.
(() => {
  const snapshot = settings => ({ windowShortcutFallback: settings?.windowShortcutFallback !== false,
    theme: ['light', 'dark', 'system'].includes(settings?.theme) ? settings.theme : 'light',
    language: settings?.language === 'en' ? 'en' : 'zh-CN' });
  function broadcast(message) {
    try { Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {}); } catch {}
    Promise.resolve().then(() => chrome.tabs.query({})).then(tabs => Promise.all(tabs.map(tab => {
      if (!Number.isInteger(tab.id) || !/^https?:\/\//i.test(tab.url || '')) return;
      return chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }))).catch(() => {});
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.laterOnSettings) broadcast({ type: 'LATERON_PREFERENCES', settings: snapshot(changes.laterOnSettings.newValue) });
  });
  globalThis.LaterOnContentMessages = { broadcast };
})();

// Only presentation, shortcut eligibility and small mode definitions cross into web frames.
// Bookmark trees, images and service credentials never enter these messages.
(() => {
  const snapshot = settings => ({ windowShortcutFallback: settings?.windowShortcutFallback !== false,
    theme: ['light', 'dark', 'system'].includes(settings?.theme) ? settings.theme : 'light',
    language: settings?.language === 'en' ? 'en' : 'zh-CN',
    ...(globalThis.LaterOnQuickModes ? { quickSwitcherModes: LaterOnQuickModes.normalize(settings?.quickSwitcherModes) } : {}) });
  function broadcast(message, isCurrent = () => true) {
    if (!isCurrent()) return;
    try { Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {}); } catch {}
    Promise.resolve().then(() => chrome.tabs.query({})).then(tabs => Promise.all(tabs.map(tab => {
      if (!isCurrent() || !Number.isInteger(tab.id) || !/^https?:\/\//i.test(tab.url || '')) return;
      return chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }))).catch(() => {});
  }
  let preferenceGeneration = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.laterOnSettings) return;
    const generation = ++preferenceGeneration;
    broadcast({ type: 'LATERON_PREFERENCES', settings: snapshot(changes.laterOnSettings.newValue) }, () => generation === preferenceGeneration);
  });
  globalThis.LaterOnContentMessages = { broadcast };
})();

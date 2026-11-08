// Web frames subscribe to tiny preference messages instead of storage events:
// a storage listener would also receive every complete bookmark/cover update.
(() => {
  const api = globalThis.chrome;
  if (globalThis.LaterOnContentPreferences?.runtime === api?.runtime) return;
  if (!api?.runtime?.onMessage || !api?.storage?.local?.get) return;
  let value = null, version = 0;
  const subscribers = new Set();
  const snapshot = settings => ({ windowShortcutFallback: settings?.windowShortcutFallback !== false,
    theme: ['light', 'dark', 'system'].includes(settings?.theme) ? settings.theme : 'light',
    language: settings?.language === 'en' ? 'en' : 'zh-CN',
    ...(globalThis.LaterOnQuickModes ? { quickSwitcherModes: LaterOnQuickModes.normalize(settings?.quickSwitcherModes) } : {}) });
  function apply(settings) {
    value = snapshot(settings);
    for (const subscriber of subscribers) { try { subscriber(value); } catch {} }
  }
  api.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== 'LATERON_PREFERENCES' || sender?.id !== api.runtime.id) return;
    version++; apply(message.settings);
  });
  const initial = version;
  const ready = Promise.resolve().then(() => api.storage.local.get('laterOnSettings')).then(stored => {
    if (version === initial) apply(stored?.laterOnSettings);
    return value;
  }).catch(() => { if (version === initial) apply(); return value; });
  globalThis.LaterOnContentPreferences = { ready, runtime: api.runtime, get value() { return value; }, subscribe(callback) {
    subscribers.add(callback); if (value) callback(value); return () => subscribers.delete(callback);
  } };
})();

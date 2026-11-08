// One worker owns settings read/merge/write across extension pages and windows.
(() => {
  const KEY = 'laterOnSettings';
  let writeQueue = Promise.resolve();
  const booleanKeys = new Set(['autoMarkRead', 'askFolderOnBatch', 'askFolderOnSingle',
    'askFolderOnSingleOptIn', 'windowShortcutFallback']);
  const choices = { theme: ['light', 'dark', 'system'], language: ['zh-CN', 'en'],
    defaultSort: ['newest', 'oldest', 'source', 'custom'] };
  function validate(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('settingsInvalid');
    const result = {};
    for (const [key, value] of Object.entries(patch)) {
      if (booleanKeys.has(key)) {
        if (typeof value !== 'boolean') throw Error('settingsInvalid');
        result[key] = value;
      } else if (Object.prototype.hasOwnProperty.call(choices, key)) {
        if (!choices[key].includes(value)) throw Error('settingsInvalid');
        result[key] = value;
      } else if (key === 'autoCleanDays') {
        if (value !== null && !(Number.isInteger(value) && value >= 0)) throw Error('settingsInvalid');
        result[key] = value;
      } else if (key === 'quickSwitcherModes') {
        const modes = globalThis.LaterOnQuickModes.validate(value);
        if (!modes.ok) throw Error('settingsInvalid');
        result[key] = modes.modes;
      } else throw Error('settingsInvalid');
    }
    if (Object.prototype.hasOwnProperty.call(result, 'askFolderOnSingle')) result.askFolderOnSingleOptIn = true;
    return result;
  }
  function set(patch, order) {
    const normalized = validate(patch);
    let extra = {};
    if (order !== undefined) {
      if (!order || typeof order !== 'object' || Array.isArray(order)
        || Object.values(order).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw Error('settingsInvalid');
      extra = { laterOnOrder: Object.fromEntries(Object.entries(order).map(([scope, ids]) => [scope, [...ids]])) };
    }
    const pending = writeQueue.then(async () => {
      const stored = await chrome.storage.local.get(KEY);
      const settings = { ...(stored[KEY] || {}), ...normalized };
      await chrome.storage.local.set({ [KEY]: settings, ...extra });
      return settings;
    });
    writeQueue = pending.catch(() => {});
    return pending;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'LATERON_SETTINGS_SET') return;
    if (sender?.id !== chrome.runtime.id || typeof sender?.url !== 'string'
      || !sender.url.startsWith(chrome.runtime.getURL(''))) {
      sendResponse({ ok: false, error: 'settingsForbidden' }); return false;
    }
    Promise.resolve().then(() => set(message.patch, message.order)).then(
      settings => sendResponse({ ok: true, settings }),
      error => sendResponse({ ok: false, error: error?.message === 'settingsInvalid' ? 'settingsInvalid' : 'settingsWriteFailed' })
    );
    return true;
  });
  globalThis.LaterOnSettingsWriter = { set };
})();

// Keep the former window-save default available on web pages while Chrome's
// four suggested command slots include the native Quick Switcher shortcut.
(() => {
  if (window.LaterOnKeyboardShortcuts) return;
  const api = globalThis.chrome;
  if (!api?.runtime?.sendMessage || !api?.storage?.local?.get) return;
  const SETTINGS = 'laterOnSettings';
  const document = globalThis.document;
  let allowed = null, enabled = false, version = 0, eligibilityVersion = 0;
  let checking = null, refreshTimer = null, lastCheck = -Infinity;
  const focused = () => document?.visibilityState !== 'hidden' && (!document?.hasFocus || document.hasFocus());
  const cancelRefresh = () => { clearTimeout(refreshTimer); refreshTimer = null; };
  function refresh(force = false) {
    // A previously valid fallback is no longer certain after returning from
    // Chrome's shortcut settings. Leave the key alone until the worker checks.
    enabled = false;
    if (!allowed || !focused() || checking) return;
    const delay = Math.max(0, lastCheck + 500 - Date.now());
    if (!force && delay) {
      if (refreshTimer === null) refreshTimer = setTimeout(() => { refreshTimer = null; refresh(true); }, delay);
      return;
    }
    cancelRefresh(); lastCheck = Date.now();
    const generation = eligibilityVersion;
    const task = Promise.resolve().then(() => api.runtime.sendMessage({ type: 'QUICK_SWITCHER_LEGACY_STATUS' })).then(response => {
      if (generation === eligibilityVersion && allowed && focused()) enabled = response?.ok === true && response.enabled === true;
    }).catch(() => { /* Unknown eligibility must never claim a webpage key. */ }).finally(() => {
      if (checking === task) checking = null;
      if (allowed && generation !== eligibilityVersion) refresh(true);
    });
    checking = task;
  }
  const apply = settings => {
    const next = settings?.windowShortcutFallback !== false;
    if (allowed === next) return;
    allowed = next; enabled = false; eligibilityVersion++; cancelRefresh();
    if (allowed) refresh(true);
  };
  window.LaterOnKeyboardShortcuts = {};

  // A saved opt-out must take effect before the first possible keypress. A
  // newer settings event also wins over a delayed initial storage response.
  try {
    api.storage.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS]) return;
      version++; apply(changes[SETTINGS].newValue);
    });
  } catch { /* An invalidated extension context cannot update preferences. */ }
  const initialVersion = version;
  try {
    Promise.resolve(api.storage.local.get(SETTINGS)).then(stored => {
      if (version === initialVersion) apply(stored?.[SETTINGS]);
    }, () => { if (version === initialVersion) apply(); });
  } catch { apply(); }

  // Only the focused frame asks for eligibility. Input-focus capture events,
  // background documents and rapid focus/visibility pairs do not fan out work.
  window.addEventListener('focus', event => { if (event.target === window) refresh(); });
  window.addEventListener('blur', event => { if (event.target === window) { enabled = false; cancelRefresh(); } });
  document?.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
    else { enabled = false; cancelRefresh(); }
  });

  // Register after picker-keyboard-guard.js. Its current modal owner consumes
  // keys with stopImmediatePropagation before this listener can see them.
  window.addEventListener('keydown', event => {
    if (!enabled || event.isTrusted !== true || event.defaultPrevented || event.repeat
      || event.isComposing || event.keyCode === 229 || event.key === 'Process'
      || event.code !== 'Digit2' || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      // The worker checks actual native command bindings before saving, so a
      // user-assigned shortcut cannot cause a native and fallback double save.
      Promise.resolve(api.runtime.sendMessage({ type: 'QUICK_SWITCHER_LEGACY_WINDOW' })).catch(() => {});
    } catch { /* Context invalidation is normal after reloading the extension. */ }
  }, true);
})();

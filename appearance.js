// Apply cached presentation before styles/body paint; never cache library membership here.
(() => {
  const KEY = 'laterOnAppearance';
  const valid = value => value && ['light', 'dark', 'system'].includes(value.theme) && ['zh-CN', 'en'].includes(value.language);
  let cached;
  for (const name of ['sessionStorage', 'localStorage']) {
    try { const value = JSON.parse(window[name].getItem(KEY)); if (valid(value)) { cached = value; break; } } catch {}
  }
  let current = cached ? { theme: cached.theme, language: cached.language } : { theme: 'system', language: 'zh-CN' };
  let persisted = null;
  const root = document.documentElement;
  const url = new URL(location.href);
  const compact = url.pathname.endsWith('/sidepanel.html') || url.pathname.endsWith('/bookmarks.html') && url.searchParams.get('surface') === 'sidepanel';
  root.classList.toggle('sidepanel-surface', compact);
  if (compact && url.pathname.endsWith('/bookmarks.html')) root.classList.add('bookmark-sidepanel');
  function paint() {
    const dark = current.theme === 'dark' || current.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.lang = current.language;
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.style.backgroundColor = dark ? '#151413' : '#f4f2ec';
    root.style.setProperty('--boot-paper', dark ? '#151413' : '#f4f2ec');
    root.style.setProperty('--boot-ink', dark ? '#f3f1ec' : '#171614');
    root.style.setProperty('--boot-card', dark ? '#211f1d' : '#ffffff');
    root.style.setProperty('--boot-cover', dark ? '#2a2725' : '#e4e0d7');
  }
  function update(patch) {
    const next = { ...current, ...patch };
    if (!valid(next)) return;
    current = { theme: next.theme, language: next.language };
    paint();
    const serialized = JSON.stringify(current);
    if (serialized === persisted) return;
    persisted = serialized;
    for (const name of ['sessionStorage', 'localStorage']) {
      try { window[name].setItem(KEY, serialized); } catch {}
    }
  }
  paint();
  window.LaterOnAppearance = { update, get: () => ({ ...current }) };
})();

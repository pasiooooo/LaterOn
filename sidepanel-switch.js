// Keep both side-panel documents alive. A switch reveals a fully mounted view,
// so its shared header, current-page preview and list never repaint as a boot screen.
(() => {
  const current = new URL(location.href);
  function surface(url) {
    if (url.protocol !== current.protocol || url.host !== current.host) return '';
    if (url.pathname === new URL('sidepanel.html', current).pathname) return 'reading';
    if (url.pathname === new URL('bookmarks.html', current).pathname && url.searchParams.get('surface') === 'sidepanel') return 'bookmarks';
    return '';
  }
  const home = surface(current);
  if (!home) return;
  let controller;
  try {
    if (parent !== window && parent.LaterOnSidepanelSwitch?.owns(window)) controller = parent.LaterOnSidepanelSwitch;
  } catch {}
  if (!controller) {
    let alternate = null, alternateReady = false, active = home, requested = home;
    let timer = null, homeScroll = 0;
    const setBusy = value => document.querySelectorAll('.library-switch').forEach(nav => {
      if (value) nav.setAttribute('aria-busy', 'true');
      else nav.removeAttribute('aria-busy');
    });
    function show(target) {
      if (target !== home && !alternateReady) return;
      clearTimeout(timer); setBusy(false);
      if (target === active) return;
      if (active === home) homeScroll = window.scrollY;
      active = target;
      document.documentElement.classList.toggle('sidepanel-alternate-active', target !== home);
      alternate?.classList.toggle('is-active', target !== home);
      if (alternate) alternate.inert = target === home;
      const view = target === home ? window : alternate.contentWindow;
      if (target === home) window.scrollTo({ top: homeScroll, behavior: 'instant' });
      view.document.querySelector('.library-switch a[aria-current="page"]')?.focus({ preventScroll: true });
      view.dispatchEvent(new Event('lateron-sidepanel-visible'));
    }
    controller = {
      owns(view) { return alternate?.contentWindow === view; },
      isActive(view = window) { return view === window ? active === home : alternate?.contentWindow === view && active !== home; },
      ready(view = window) {
        if (alternate?.contentWindow !== view) return;
        alternateReady = true;
        if (requested !== home) show(requested);
      },
      navigate(href) {
        const url = new URL(href, current), target = surface(url);
        if (!target) return false;
        requested = target;
        if (target === home) {
          // An explicit transfer into a bookmark document is a new operation.
          if (url.searchParams.has('items')) { location.assign(url.href); return true; }
          show(home); setBusy(false); clearTimeout(timer); return true;
        }
        const newOperation = url.searchParams.has('items') || url.searchParams.has('folder');
        if (alternate && newOperation) { show(home); alternate.remove(); alternate = null; alternateReady = false; }
        if (!alternate) {
          alternate = document.createElement('iframe');
          alternate.id = 'laterOnAlternatePanel';
          alternate.className = 'sidepanel-alternate';
          alternate.title = target === 'bookmarks' ? (window.LaterOnI18n?.t('bookmarkLibrary') || 'Bookmarks') : (window.LaterOnI18n?.t('readingLibrary') || 'Reading');
          alternate.inert = true;
          alternate.src = url.href;
          document.body.append(alternate);
        }
        if (alternateReady) show(target);
        else {
          setBusy(true); clearTimeout(timer);
          timer = setTimeout(() => {
            if (alternateReady) return;
            requested = home; setBusy(false);
            alternate?.remove(); alternate = null;
            const status = document.querySelector('#status, #bookmarkStatus');
            if (status) status.textContent = window.LaterOnI18n?.t('loadFailedRetry') || 'Please try again.';
          }, 12000);
        }
        return true;
      }
    };
  }
  const owner = controller;
  window.LaterOnSidepanelSwitch = {
    owns: view => owner.owns(view),
    isActive: (view = window) => owner.isActive(view),
    ready: (view = window) => owner.ready(view),
    navigate: href => owner.navigate(href)
  };
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('.library-switch a, a.brand');
    if (!link || !surface(new URL(link.href))) return;
    event.preventDefault(); owner.navigate(link.href);
  });
})();

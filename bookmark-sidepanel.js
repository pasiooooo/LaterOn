// One bookmark controller/data model, with a purpose-built browser side-panel surface.
(() => {
  const enabled = new URL(location.href).searchParams.get('surface') === 'sidepanel';
  if (enabled) {
    document.documentElement.classList.add('bookmark-sidepanel', 'sidepanel-surface');
    for (const id of ['bookmarkSidepanelBase', 'bookmarkSidepanelStyle']) document.getElementById(id).media = 'all';
  }
  // Started from <head>: saved view, config and permission are read in
  // parallel, then the first bounded page comes straight from IndexedDB while
  // the remaining scripts parse. bookmarks.js validates it before use.
  const VIEW_KEY = enabled ? 'laterOnBookmarkSidepanelView' : 'laterOnBookmarkView', PAGE_FIRST = enabled ? 12 : 48;
  let started = null;
  function prefetch() {
    if (started) return started;
    const requested = new URL(location.href).searchParams.get('folder');
    const stored = chrome.storage.local.get([VIEW_KEY, 'laterOnBookmarkConfig', 'laterOnBookmarkStateMeta', 'laterOnQuickSearchPending']).catch(() => ({}));
    const permission = Promise.resolve(chrome.permissions?.contains?.({ permissions: ['bookmarks'] })).catch(() => null);
    const view = Promise.all([stored, permission]).then(([values, granted]) => {
      const config = values?.laterOnBookmarkConfig, saved = values?.[VIEW_KEY];
      if (!globalThis.LaterOnLocalIndex?.bookmarkView || granted !== true || config?.enabled !== true) return null;
      const request = { selected: requested !== null ? requested : typeof saved?.selected === 'string' ? saved.selected : '', query: '', limit: PAGE_FIRST, folderLimit: 24 };
      return globalThis.LaterOnLocalIndex.bookmarkView(request, { bookmarkPermission: true, bookmarkConfig: config })
        .then(async result => {
          const facts = values?.laterOnBookmarkStateMeta, pending = values?.laterOnQuickSearchPending;
          if (result && ((result.updatedAt || 0) < (facts?.updatedAt || 0)
            || pending?.bookmarks && (pending.nativeAt || 0) > (facts?.nativeVerifiedAt || 0))) result = null;
          if (!result) {
            const reply = await chrome.runtime.sendMessage({ type: 'BOOKMARKS_VIEW', ...request }).catch(() => null);
            result = reply?.ok ? reply.state : null;
          }
          return result && { request, result };
        }, () => null);
    }).catch(() => null);
    return started = { stored, permission, view };
  }
  try { if (globalThis.chrome?.storage?.local) prefetch(); } catch { started = null; }
  function mount({ t, getSelected, onAdd, onError, onFoldersShown, isBookmarked }) {
    if (!enabled) return null;
    const $ = selector => document.querySelector(selector);
    const sidebar = $('.bookmark-sidebar'), tools = $('#bookmarkSidepanelTools');
    for (const id of ['bookmarkOpenFull', 'bookmarkSidepanelNavigation', 'bookmarkCurrentPage', 'bookmarkSidepanelSearch', 'bookmarkSidepanelControls']) $('#' + id).hidden = false;
    $('#bookmarkSidepanelNavigation').append($('.library-switch'));
    $('.library-switch a[data-i18n="readingLibrary"]').href = 'sidepanel.html';
    $('.library-switch a[data-i18n="bookmarkLibrary"]').href = 'bookmarks.html?surface=sidepanel';
    $('.brand').href = 'sidepanel.html';
    $('#bookmarkSidepanelSearch').append($('.bookmark-header .search'));
    $('#bookmarkSidepanelCount').append($('#bookmarkCount'));
    $('#bookmarkSidepanelFolders').append(sidebar);
    tools.append($('.bookmark-toolbar-actions'), $('.bookmark-sidebar-footer'));
    const settings = tools.querySelector('a[href="settings.html"]');
    settings.target = '_blank'; settings.rel = 'noopener';
    sidebar.hidden = true;
    function navigated() {
      const returnFocus = sidebar.contains(document.activeElement);
      sidebar.hidden = true; $('#bookmarkSidepanelFolders').hidden = true;
      $('#bookmarkToggleFolders').setAttribute('aria-expanded', 'false');
      if (returnFocus) $('#bookmarkToggleFolders').focus({ preventScroll: true });
    }
    $('#bookmarkToggleFolders').addEventListener('click', () => {
      tools.open = false;
      sidebar.hidden = !sidebar.hidden;
      $('#bookmarkSidepanelFolders').hidden = sidebar.hidden;
      $('#bookmarkToggleFolders').setAttribute('aria-expanded', String(!sidebar.hidden));
      // The tree is not built while collapsed; build it when it is opened.
      if (!sidebar.hidden) onFoldersShown?.();
    });
    for (const selector of ['#bookmarkNewPage', '#bookmarkNewFolder', '#bookmarkSettingsShortcut']) $(selector).addEventListener('click', () => { tools.open = false; });
    document.addEventListener('click', event => { if (!tools.contains(event.target)) tools.open = false; });
    let currentTab = null, currentMetadata = null, querying = false, ownerWindowId = null, currentState = { nodes: [] }, writable = false, busy = false, generation = 0, opening = false;
    // A bounded snapshot holds one page of bookmarks, so membership of the
    // current tab is an indexed lookup instead of a scan of visible rows.
    let member = { key: '', saved: false, pending: false };
    function savedInSnapshot(url) {
      if (!currentState.partial) return { saved: !!currentState.nodes.find(node => node.url && webUrl(node.url) === url), pending: false };
      const key = `${url}\u0000${currentState.updatedAt || 0}\u0000${currentState.scopeId || ''}`;
      if (member.key !== key) {
        member = { key, saved: false, pending: true };
        Promise.resolve(isBookmarked?.([...new Set([url, currentTab?.url].filter(Boolean))])).catch(() => null).then(saved => {
          if (member.key !== key) return;
          member = { key, saved: saved === true, pending: false }; renderCurrent();
        });
      }
      return member;
    }
    const webUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
    function renderCurrent() {
      const url = webUrl(currentTab?.url);
      const membership = url ? savedInSnapshot(url) : { saved: false, pending: false }, saved = membership.saved;
      $('#bookmarkCurrentTitle').textContent = currentMetadata?.title || window.LaterOnUrl?.searchTitle?.(currentTab?.url) || currentTab?.title || t('currentPage');
      $('#bookmarkCurrentSource').textContent = currentMetadata?.source || (url ? new URL(url).hostname : t('unsupportedCurrent'));
      if (currentTab) {
        $('#bookmarkCurrentTitle').removeAttribute('data-bm'); $('#bookmarkCurrentSource').removeAttribute('data-bm');
      }
      $('#bookmarkSaveCurrent').disabled = querying || !url || !writable || busy || !!saved || membership.pending;
      $('#bookmarkSaveCurrent').classList.toggle('saved', !!saved);
      const label = t(saved ? 'alreadyBookmarked' : 'saveCurrent');
      $('#bookmarkSaveCurrent .save-label').textContent = label;
      $('#bookmarkSaveCurrent').title = label; $('#bookmarkSaveCurrent').setAttribute('aria-label', label);
      const image = currentMetadata?.image;
      const cover = webUrl(image) || (typeof image === 'string' && image.length <= 768 * 1024 && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(image) ? image : '');
      const thumb = $('#bookmarkCurrentThumb');
      if ((thumb.dataset.cover || '') !== cover) {
        thumb.dataset.cover = cover; thumb.querySelector('.bookmark-current-cover')?.remove(); thumb.classList.remove('has-cover');
        if (cover) {
          const img = document.createElement('img'); img.className = 'bookmark-current-cover'; img.alt = ''; img.referrerPolicy = 'no-referrer';
          img.onload = () => { if (img.parentElement === thumb) thumb.classList.add('has-cover'); };
          img.onerror = () => { if (img.parentElement === thumb) { img.remove(); thumb.classList.remove('has-cover'); } };
          img.src = cover; thumb.append(img);
        }
      }
    }
    async function loadCurrent({ invalidate = false } = {}) {
      const run = ++generation;
      if (invalidate) { currentTab = null; currentMetadata = null; }
      querying = true; renderCurrent();
      if (!currentTab) $('#bookmarkCurrentSource').textContent = t('loadingCurrent');
      let timer;
      try {
        const tabs = await Promise.race([chrome.tabs.query(ownerWindowId ? { active: true, windowId: ownerWindowId } : { active: true, currentWindow: true }), new Promise(resolve => { timer = setTimeout(() => resolve([]), 4000); })]);
        if (run !== generation) return;
        clearTimeout(timer);
        const tab = tabs[0] || null;
        if (invalidate || tab?.id !== currentTab?.id || tab?.url !== currentTab?.url) currentMetadata = null;
        currentTab = tab; querying = false; ownerWindowId = currentTab?.windowId || ownerWindowId; renderCurrent();
        if (!webUrl(tab?.url)) return;
        const response = await Promise.race([
          chrome.runtime.sendMessage({ type: 'EXTRACT_METADATA', tabId: tab.id }).catch(() => null),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); })
        ]);
        if (run !== generation) return;
        if (response?.ok && response.metadata?.url === currentTab?.url) {
          currentMetadata = response.metadata; renderCurrent();
        }
      } catch {
        if (run === generation) { querying = false; currentTab = null; currentMetadata = null; renderCurrent(); }
      }
      finally { clearTimeout(timer); }
    }
    $('#bookmarkSaveCurrent').addEventListener('click', () => {
      if (!$('#bookmarkSaveCurrent').disabled && currentTab) { tools.open = false; onAdd({ ...currentTab, ...currentMetadata, id: currentTab.id, url: currentTab.url }); }
    });
    const activated = info => {
      if (!ownerWindowId || info.windowId === ownerWindowId) loadCurrent({ invalidate: info.tabId !== currentTab?.id });
    };
    const updated = (id, change, tab) => {
      if (!tab.active || ownerWindowId && ownerWindowId !== tab.windowId) return;
      if (change.status === 'loading' || change.status === 'complete' || change.url) loadCurrent({ invalidate: change.status === 'loading' || !!change.url });
      else if (id === currentTab?.id && change.title) {
        currentTab = { ...currentTab, ...tab };
        if (currentMetadata?.titleFrom === 'tab') currentMetadata = { ...currentMetadata, title: tab.title };
        renderCurrent();
      }
    };
    chrome.tabs?.onActivated?.addListener(activated);
    chrome.tabs?.onUpdated?.addListener(updated);
    $('#bookmarkOpenFull').addEventListener('click', async () => {
      if (opening) return;
      opening = true;
      try {
        const url = new URL(chrome.runtime.getURL('bookmarks.html'));
        url.searchParams.set('folder', getSelected());
        const windowId = ownerWindowId;
        await chrome.tabs.create({ url: url.href, ...(windowId ? { windowId } : {}) });
        if (windowId && chrome.sidePanel?.close) { try { await chrome.sidePanel.close({ windowId }); } catch {} }
      } catch { onError(); }
      finally { opening = false; }
    });
    loadCurrent();
    return { navigated, relabel: renderCurrent, foldersVisible: () => !sidebar.hidden, render({ state, busy: nextBusy, writable: nextWritable, title, pages }) {
      currentState = state; busy = nextBusy; writable = nextWritable;
      $('#bookmarkSidepanelFolderLabel').textContent = title;
      $('#bookmarkToggleFolders').title = title;
      $('#bookmarkCount').textContent = state.provisional && !state.view?.countKnown ? t('updating') : t('count', { n: pages });
      renderCurrent();
    } };
  }
  window.LaterOnBookmarkSidepanel = { enabled, mount, prefetch };
})();

(() => {
  window.LaterOnBookmarkTransfer = {
    async open(ids) {
      if (!Array.isArray(ids) || !ids.length) return;
      const url = new URL(chrome.runtime.getURL('bookmarks.html'));
      url.searchParams.set('items', JSON.stringify([...new Set(ids)]));
      try {
        if (new URL(window.location.href).pathname.endsWith('/sidepanel.html')) {
          url.searchParams.set('surface', 'sidepanel');
          if (!window.LaterOnSidepanelSwitch?.navigate(url.href)) window.location.assign(url.href);
        } else await chrome.tabs.create({ url: url.href });
      }
      catch {
        await window.LaterOnDialog?.alert({ title: window.LaterOnI18n?.t('bookmarkLibrary') || 'Bookmarks',
          message: window.LaterOnI18n?.t('operationFailed') || 'Please try again.' });
      }
    }
  };
})();

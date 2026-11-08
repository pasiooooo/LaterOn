// One keyboard-first search surface for web pages and extension-owned windows.
(() => {
  if (globalThis.LaterOnQuickSwitcherUI) return;
  let current = null;
  const HOST_ID = 'lateron-quick-switcher';
  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', { search: 'm21 21-4.4-4.4M19 10.8a8.2 8.2 0 1 1-16.4 0 8.2 8.2 0 0 1 16.4 0Z', close: 'm6 6 12 12M6 18 18 6', reading: 'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM13 7a3 3 0 0 1 3-3h4v15h-3a4 4 0 0 0-4 2', bookmark: 'M6 3h12v18l-6-4-6 4z', tabs: 'M4 8h16v12H4zM8 4h12v4M4 12h16', globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z' }[name]);
    svg.append(path); return svg;
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const safeUrl = value => { try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } };
  function open(options = {}) {
    const previousFocus = current?.previousFocus || document.activeElement;
    current?.close({ restoreFocus: false });
    document.getElementById(HOST_ID)?.remove();
    const en = options.language === 'en';
    const words = en ? {
      title: 'Quick Switcher', placeholder: 'Search tabs, pages, URLs or folders…', close: 'Close Quick Switcher', recent: 'Recent pages', matches: 'Search results',
      loading: 'Searching your library…', empty: 'No matching pages', emptyHint: 'Try a title, website, project or folder.', noPages: 'Your saved pages will appear here', noPagesHint: 'Add pages to Reading or connect your Bookmarks to get started.',
      failed: 'Couldn’t search your pages', retry: 'Try again', openFailed: 'Couldn’t open this page. Please try again.', opening: 'Opening…',
      reading: 'Reading', bookmarks: 'Bookmarks', tabs: 'Tabs', all: 'All', default: 'Default', modes: 'Search mode', mode: n => `Mode ${n}`, move: 'Select', enter: 'Open / switch', newTab: 'New tab', dismiss: 'Close', pages: n => `${n} pages`, limited: (shown, total) => `${shown} of ${total}`,
      available: n => `${n} available`, updating: 'Loading more pages…'
    } : {
      title: '快速切换', placeholder: '搜索标签页、网页、网址或文件夹…', close: '关闭快速切换', recent: '最近网页', matches: '搜索结果',
      loading: '正在搜索资料库…', empty: '没有匹配的网页', emptyHint: '试试标题、网站、项目或文件夹名称。', noPages: '已保存的网页会出现在这里', noPagesHint: '添加网页到阅读库，或连接书签库后即可搜索。',
      failed: '暂时无法搜索网页', retry: '重试', openFailed: '网页未能打开，请重试。', opening: '正在打开…',
      reading: '阅读库', bookmarks: '书签库', tabs: '标签页', all: '全部', default: '默认', modes: '搜索模式', mode: n => `模式 ${n}`, move: '选择', enter: '打开 / 切换', newTab: '新标签页', dismiss: '关闭', pages: n => `${n} 个网页`, limited: (shown, total) => `${shown} / ${total}`,
      available: n => `${n} 个可用结果`, updating: '正在读取其余网页…'
    };
    const host = element('div'); host.id = HOST_ID;
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');
    const setting = options.theme || 'light';
    host.dataset.theme = setting === 'dark' || setting !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    host.lang = en ? 'en' : 'zh-CN';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = element('style');
    style.textContent = String(options.styles?.theme || '').replace(/:root\b/g, ':host').replace(/\[data-theme="dark"\]/g, ':host([data-theme="dark"])') + '\n' + String(options.styles?.component || '');
    shadow.append(style);
    const dialog = element('dialog', 'qs-dialog');
    dialog.setAttribute('aria-labelledby', 'lateron-switcher-title');
    dialog.setAttribute('aria-modal', 'true');
    const title = element('h2', 'qs-sr-only', words.title); title.id = 'lateron-switcher-title';
    const header = element('header', 'qs-search');
    const input = element('input', 'qs-input'); input.type = 'search'; input.placeholder = words.placeholder; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', words.placeholder); input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'lateron-switcher-results');
    const closeButton = element('button', 'qs-close'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', words.close); closeButton.title = words.close;
    closeButton.append(element('kbd', '', 'esc'));
    header.append(icon('search'), input, closeButton);
    const summary = element('div', 'qs-summary');
    const label = element('span', 'qs-summary-label', words.recent), count = element('span', 'qs-count'); summary.append(label, count);
    const modeBar = element('div', 'qs-mode-bar'), modeButtons = element('div', 'qs-modes'), modeScope = element('span', 'qs-mode-scope');
    modeButtons.setAttribute('role', 'group'); modeButtons.setAttribute('aria-label', words.modes); modeBar.append(modeButtons, modeScope);
    const body = element('div', 'qs-body');
    const list = element('div', 'qs-list'); list.id = 'lateron-switcher-results'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', words.matches);
    const status = element('div', 'qs-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    body.append(list, status);
    const footer = element('footer', 'qs-footer');
    const keys = element('div', 'qs-keys');
    const shortcut = (key, text, className = '') => { const hint = element('span', `qs-key-hint ${className}`); hint.append(element('kbd', '', key), element('span', '', text)); return hint; };
    const mac = /Mac|iPhone|iPad/i.test(window.navigator.platform || window.navigator.userAgent || '');
    keys.append(shortcut('↑ ↓', words.move), shortcut('↵', words.enter), shortcut(mac ? '⌘ ↵' : 'Ctrl ↵', words.newTab, 'qs-new-tab-hint'), shortcut('esc', words.dismiss));
    const live = element('span', 'qs-live qs-sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    footer.append(keys, element('span', 'qs-brand', 'LaterOn'), live);
    dialog.append(title, header, modeBar, summary, body, footer); shadow.append(dialog);
    (options.container || document.body || document.documentElement).append(host);
    let closed = false, generation = 0, searchTimer = null, selected = 0, rows = [], results = [], renderedQuery = '', total = 0, opening = false, composing = false, releaseKeyboard = null;
    let resultsReady = false, confirming = false, confirmationSequence = 0;
    const modeTools = globalThis.LaterOnQuickModes;
    let modes = modeTools.normalize(options.modes), modeId = 'default', renderedMode = '', iconsObserver = null;
    let resizeFrame = null;
    const fallbackEvents = ['keydown', 'keypress', 'keyup'];
    function close({ restoreFocus = true } = {}) {
      if (closed) return;
      closed = true; generation++; clearTimeout(searchTimer); releaseKeyboard?.();
      confirmationSequence++; iconsObserver?.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
      window.removeEventListener('resize', resizeSelection);
      fallbackEvents.forEach(type => window.removeEventListener(type, fallbackKeyboard, true));
      try { if (dialog.open && typeof dialog.close === 'function') dialog.close(); } catch {}
      host.remove();
      if (current === api) current = null;
      if (restoreFocus && previousFocus?.isConnected) { try { previousFocus.focus({ preventScroll: true }); } catch {} }
      try { options.onClose?.(); } catch {}
    }
    const api = { close, focus() { if (!closed) input.focus({ preventScroll: true }); }, refresh: runSearch, setModes, host, shadow, previousFocus,
      get modeId() { return modeId; } };
    current = api;
    const selectedMode = () => modeTools.get(modes, modeId);
    function invalidate(clearRows = false) {
      generation++; resultsReady = false; confirming = false; confirmationSequence++; clearTimeout(searchTimer); searchTimer = null;
      live.classList.add('qs-sr-only'); live.classList.remove('qs-open-error'); list.setAttribute('aria-busy', 'true');
      if (clearRows) {
        iconsObserver?.disconnect(); results = []; rows = []; list.replaceChildren(); list.hidden = true;
        input.removeAttribute('aria-activedescendant');
      }
    }
    function displayModes() {
      modeButtons.replaceChildren();
      for (const [index, mode] of modes.entries()) {
        const name = index === 0 ? mode.sources.length === 3 ? words.all : words.default
          : mode.sources.length === 3 ? words.all : mode.sources.length === 1 ? words[mode.sources[0]] : words.mode(index);
        const button = element('button', 'qs-mode', name); button.type = 'button'; button.dataset.modeId = mode.id;
        button.setAttribute('aria-pressed', String(mode.id === modeId));
        const prefix = modeTools.describePrefix(mode.prefix, en ? 'en' : 'zh-CN');
        button.title = [prefix, modeTools.describeSources(mode.sources, en ? 'en' : 'zh-CN')].filter(Boolean).join(' · ');
        if (mode.prefix) button.append(element('kbd', '', prefix));
        button.addEventListener('click', () => { switchMode(mode.id); input.focus({ preventScroll: true }); });
        modeButtons.append(button);
      }
      modeScope.textContent = modeTools.describeSources(selectedMode().sources, en ? 'en' : 'zh-CN');
      modeScope.title = modeScope.textContent;
    }
    function consumePrefix() {
      if (composing) return false;
      const match = modeTools.matchPrefix(input.value, modes);
      if (!match) return false;
      // A separator following a pasted/custom trigger belongs to the query,
      // not another trigger. Search already ignores this leading whitespace.
      modeId = match.modeId; input.value = match.query.trimStart();
      displayModes(); return true;
    }
    function switchMode(id) {
      if (closed || opening) return;
      modeId = modeTools.get(modes, id).id; invalidate(true); displayModes(); runSearch();
    }
    function setModes(raw) {
      if (closed) return;
      const next = modeTools.normalize(raw);
      if (JSON.stringify(next) === JSON.stringify(modes)) return;
      modes = next; invalidate(true); displayModes();
      if (!composing) runSearch();
    }
    displayModes();
    function select(index, scroll = false) {
      if (!results.length) { input.removeAttribute('aria-activedescendant'); return; }
      selected = Math.max(0, Math.min(results.length - 1, index));
      rows.forEach((row, i) => { row.classList.toggle('is-selected', selected === i); row.setAttribute('aria-selected', String(selected === i)); });
      input.setAttribute('aria-activedescendant', rows[selected].id);
      if (scroll) rows[selected].scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'instant', container: 'nearest' });
    }
    function resizeSelection() {
      if (closed || resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (!closed && host.isConnected) select(selected, true);
      });
    }
    window.addEventListener('resize', resizeSelection);
    function announce(text, hint = '', retry = false) {
      status.replaceChildren(element('p', 'qs-status-title', text));
      if (hint) status.append(element('p', 'qs-status-hint', hint));
      if (retry) { const button = element('button', 'qs-retry', words.retry); button.type = 'button'; button.addEventListener('click', runSearch); status.append(button); }
      status.hidden = false;
    }
    function badge(kind, text) {
      const mark = element('span', `qs-badge qs-badge-${kind}`); mark.title = text; mark.setAttribute('aria-label', text); mark.append(icon(kind), element('span', '', text)); return mark;
    }
    function render(response, query) {
      const previousId = query === renderedQuery && renderedMode === modeId ? results[selected]?.id : null;
      renderedQuery = query; renderedMode = modeId;
      const sources = selectedMode().sources;
      results = (Array.isArray(response?.results) ? response.results : []).filter(result => {
        const memberships = { tabs: result?.tabIds, reading: result?.readingIds, bookmarks: result?.bookmarkIds };
        const hasMembership = Object.values(memberships).some(Array.isArray);
        if (hasMembership && !sources.some(source => Array.isArray(memberships[source]) && memberships[source].length)) return false;
        return safeUrl(result?.url) || sources.includes('tabs') && typeof result?.url === 'string'
          && Array.isArray(result.tabIds) && result.tabIds.some(Number.isInteger);
      }).slice(0, 50);
      iconsObserver?.disconnect();
      iconsObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        for (const entry of entries) if (!closed && entry.isIntersecting && entry.target.isConnected) { const image = entry.target; image.src = image.dataset.favicon; iconsObserver?.unobserve(image); }
      }, { root: body }) : null;
      total = Math.max(results.length, Number(response?.total) || 0); rows = [];
      list.replaceChildren(); list.hidden = !results.length; status.hidden = !!results.length;
      const provisional = response?.provisional === true;
      count.textContent = provisional ? `${words.available(results.length)} · ${words.updating}`
        : total > results.length ? words.limited(results.length, total) : words.pages(total);
      live.textContent = provisional ? count.textContent : words.pages(total);
      for (const [index, result] of results.entries()) {
        const row = element('div', 'qs-result'); row.id = `lateron-switcher-option-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
        let domain = result.source || '', address = result.url;
        try { const parsed = new URL(result.url); domain = parsed.hostname.replace(/^www\./, ''); address = `${parsed.host}${parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : parsed.pathname}${parsed.search}${parsed.hash}`; } catch {}
        try { address = decodeURI(address); } catch {}
        const site = element('span', 'qs-site'); site.setAttribute('aria-hidden', 'true');
        const fallback = element('span', 'qs-site-fallback');
        if (safeUrl(result.url)) fallback.textContent = (domain || result.title || 'L').slice(0, 1).toUpperCase();
        else fallback.append(icon('globe'));
        site.append(fallback);
        if (safeUrl(result.url) && globalThis.chrome?.runtime?.getURL) {
          try {
            const favicon = chrome.runtime.getURL('_favicon/') + '?pageUrl=' + encodeURIComponent(result.url) + '&size=32';
            const image = element('img', 'qs-favicon'); image.alt = ''; image.decoding = 'async'; image.loading = 'lazy';
            image.addEventListener('load', () => { image.classList.add('is-loaded'); fallback.hidden = true; }, { once: true });
            image.addEventListener('error', () => { image.remove(); fallback.hidden = false; }, { once: true });
            site.append(image);
            if (iconsObserver) { image.dataset.favicon = favicon; iconsObserver.observe(image); } else image.src = favicon;
          } catch {}
        }
        const copy = element('div', 'qs-result-copy'), heading = element('div', 'qs-result-title', result.title || result.url); heading.title = result.title || result.url;
        const meta = element('div', 'qs-result-meta'), source = element('span', 'qs-source', address); source.title = result.url;
        const contexts = [...new Set([...(sources.includes('reading') ? result.projectNames || [] : []), ...(sources.includes('bookmarks') ? result.folderNames || [] : [])].filter(Boolean))];
        const path = element('span', 'qs-context', contexts.join(' / ')); path.title = contexts.join(' / ');
        const marks = element('span', 'qs-badges');
        if (sources.includes('tabs') && result.tabIds?.length) marks.append(badge('tabs', words.tabs));
        if (sources.includes('reading') && result.readingIds?.length) marks.append(badge('reading', words.reading));
        if (sources.includes('bookmarks') && result.bookmarkIds?.length) marks.append(badge('bookmark', words.bookmarks));
        row.title = [result.url, contexts.join(' / ')].filter(Boolean).join('\n');
        meta.append(source); if (contexts.length) meta.append(element('span', 'qs-dot', '·'), path); meta.append(marks);
        copy.append(heading, meta); row.append(site, copy);
        row.addEventListener('pointermove', () => { if (!opening && selected !== index) select(index); });
        row.addEventListener('mousedown', event => event.preventDefault());
        row.addEventListener('click', event => { select(index); activate({ newTab: event.metaKey || event.ctrlKey }); });
        rows.push(row); list.append(row);
      }
      if (!results.length) {
        input.removeAttribute('aria-activedescendant');
        if (provisional) announce(words.loading);
        else announce(query ? words.empty : words.noPages, query ? words.emptyHint : words.noPagesHint);
      } else select(results.some(result => result.id === previousId) ? results.findIndex(result => result.id === previousId) : 0);
    }
    async function runSearch() {
      clearTimeout(searchTimer);
      if (closed || composing) return;
      const query = input.value.trim(), run = ++generation;
      searchTimer = null; resultsReady = false;
      label.textContent = query ? words.matches : words.recent;
      list.setAttribute('aria-busy', 'true'); count.textContent = words.loading;
      if (!results.length) announce(words.loading);
      try {
        const response = await options.search(query, { modeId, sources: [...selectedMode().sources] });
        if (closed || run !== generation) return false;
        render(response, query); resultsReady = true; return true;
      } catch {
        if (closed || run !== generation) return;
        results = []; rows = []; list.replaceChildren(); list.hidden = true; count.textContent = '';
        input.removeAttribute('aria-activedescendant'); announce(words.failed, '', true);
        return false;
      } finally { if (!closed && run === generation) list.setAttribute('aria-busy', 'false'); }
    }
    async function activate({ newTab = false } = {}) {
      const result = results[selected];
      if (!result || opening || closed || composing || !resultsReady || renderedQuery !== input.value.trim() || renderedMode !== modeId) return;
      const openGeneration = generation;
      live.classList.add('qs-sr-only'); live.classList.remove('qs-open-error');
      opening = true; input.readOnly = true; dialog.setAttribute('aria-busy', 'true'); live.textContent = words.opening;
      try {
        const response = await options.onOpen(result, { newTab, modeId, sources: [...selectedMode().sources] });
        if (response === false || response?.ok === false) throw new Error('open');
        if (!closed && generation === openGeneration) close();
      } catch {
        if (!closed && generation === openGeneration) { live.classList.remove('qs-sr-only'); live.textContent = words.openFailed; live.classList.add('qs-open-error'); }
      } finally {
        opening = false;
        if (!closed) { input.readOnly = false; dialog.removeAttribute('aria-busy'); input.focus({ preventScroll: true }); }
      }
    }
    async function confirmSelection(options) {
      if (closed || opening || composing || confirming) return;
      const sequence = ++confirmationSequence; confirming = true;
      try {
        if ((!resultsReady || searchTimer || renderedQuery !== input.value.trim() || renderedMode !== modeId) && !await runSearch()) return;
        if (sequence === confirmationSequence && !closed && !composing) await activate(options);
      } finally { if (sequence === confirmationSequence) confirming = false; }
    }
    function handleKeyboard(event) {
      if (event.type !== 'keydown' || event.isTrusted !== true || closed || !host.isConnected) return;
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'Tab') {
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && shadow.activeElement === input) {
          const mode = modes.find(row => row.prefix === '\t');
          if (mode) { event.preventDefault(); switchMode(mode.id); return; }
        }
        const focusable = [...shadow.querySelectorAll('input, button')].filter(node => !node.disabled && !node.hidden && !node.closest('[hidden]'));
        const index = focusable.indexOf(shadow.activeElement), next = (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
        event.preventDefault(); focusable[next]?.focus();
      } else if (event.key === 'Backspace' && shadow.activeElement === input && !input.value && modeId !== 'default' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); switchMode('default');
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (opening || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault(); if (resultsReady) select(selected + (event.key === 'ArrowDown' ? 1 : -1), true);
      } else if (event.key === 'Enter' && shadow.activeElement === input) { event.preventDefault(); confirmSelection({ newTab: event.metaKey || event.ctrlKey }); }
    }
    function fallbackKeyboard(event) {
      if (closed || !host.isConnected) return;
      event.stopImmediatePropagation(); handleKeyboard(event);
    }
    if (window.LaterOnPickerKeyboard?.capture) releaseKeyboard = window.LaterOnPickerKeyboard.capture(handleKeyboard, () => !closed && host.isConnected);
    else fallbackEvents.forEach(type => window.addEventListener(type, fallbackKeyboard, true));
    input.addEventListener('compositionstart', () => { composing = true; invalidate(); });
    input.addEventListener('compositionend', () => { composing = false; invalidate(); if (consumePrefix()) invalidate(true); searchTimer = setTimeout(runSearch, 40); });
    input.addEventListener('input', event => { invalidate(); if (!composing && !event.isComposing) { if (consumePrefix()) invalidate(true); searchTimer = setTimeout(runSearch, 40); } });
    closeButton.addEventListener('click', () => close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!composing) close(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    try { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
    catch { dialog.setAttribute('open', ''); }
    input.focus({ preventScroll: true });
    runSearch();
    return api;
  }
  globalThis.LaterOnQuickSwitcherUI = { open, close() { current?.close(); }, get active() { return current?.host.isConnected ? current : null; } };
})();

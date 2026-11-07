(() => {
  const words = {
    'zh-CN': {
      openFull: '打开完整界面', openFullFailed: '完整界面未能打开，请重试。', loadingCurrent: '正在读取当前网页…', currentPage: '当前页面', saveCurrent: '添加', alreadyBookmarked: '已收藏', unsupportedCurrent: '请切换到可添加的 HTTP / HTTPS 网页', moreActions: '更多操作',
      syncSettings: '同步设置', permanentHint: '长期保存，不参与已读自动清除', expand: '展开文件夹', collapse: '收起文件夹', pages: '网页', morePages: '更多网页', moreFolders: '更多文件夹', folderStats: '{n} 个网页 · {folders} 个子文件夹', viewStats: '{folders} 个文件夹 · {n} 个网页', pageHint: '保留在浏览器书签中的长期收藏', emptyHint: '添加网页，或使用文件夹整理长期收藏。', addPage: '添加网页', newFolder: '新建文件夹', connected: '浏览器书签 · 已连接', notConnected: '连接浏览器书签', needsAttention: '书签同步需要处理', previewHint: '封面和摘要会自动获取，优先复用阅读库资料；无法读取时保留站点占位图。', bookmarkPreviewUnavailable: '部分站点无法读取预览，已保留本地或站点封面。', name: '书签库', reading: '阅读库', settings: '设置', eyebrow: '长期收藏 · 浏览器双向同步',
      intro: '与浏览器书签保持一致的长期收藏，独立于阅读库，不受已读自动清除影响。',
      syncTitle: '浏览器书签双向同步', syncHint: '默认同步全部书签，也可以只选择一个文件夹及其子文件夹。停用或修改范围不会删除浏览器书签。',
      enable: '启用并授权', disable: '停用同步', scope: '同步范围', all: '全部书签', applyScope: '应用范围', refresh: '刷新',
      folders: '文件夹', search: '搜索书签', add: '添加网页或文件夹', title: '名称', url: '网页地址', destination: '目标文件夹',
      folderHint: '地址留空时新建文件夹；填写地址时添加网页。', addAction: '添加', empty: '这里还没有书签。', noMatches: '没有匹配的书签。',
      transfer: '从阅读库存入书签库', transferHint: '转存会保留阅读库中的原件，日后清除原件也不会删除书签。',
      copy: '确认转存', transferCount: '待转存 {n} 个网页。启用同步后，选择目标文件夹并确认。', transferComplete: '转存已完成，阅读库中的原件已保留。',
      copyResult: '新增 {added} 个，已存在 {existing} 个，失败 {failed} 个。',
      renameFolder: '重命名文件夹', removeFolder: '删除空文件夹', edit: '编辑', move: '移动', remove: '删除', cancel: '取消', save: '保存',
      moveTitle: '移动「{name}」', deleteTitle: '删除「{name}」？', deleteHint: '这会同时从浏览器书签中删除，无法撤销。阅读库中的原件不受影响。',
      active: '已连接浏览器书签，两个方向的修改实时反映。', disabled: '尚未启用。授权后按所选范围展示书签，不会自动把阅读库写入浏览器书签。',
      working: '正在处理…', updating: '正在读取其余书签…', success: '已保存到浏览器书签。', count: '{n} 个网页', readonly: '浏览器管理 / 只读',
      privacy: '书签修改直接作用于当前浏览器。此区域不参与阅读库的清空、JSON 备份或 WebDAV 同步；跨设备书签同步由浏览器负责。',
      bookmarkPermission: '未获得书签权限，请点击「启用并授权」。', bookmarkDisabled: '请先启用书签同步。',
      bookmarkOutOfScope: '目标已移动、删除或不在当前同步范围，请刷新后重试。', bookmarkScopeMissing: '所选同步文件夹已不存在。请重新选择同步范围，当前不会改为同步全部。',
      bookmarkFolderRequired: '请选择仍然存在的文件夹。', bookmarkProtected: '浏览器根目录、同步范围根目录或受管理的书签不能修改。',
      bookmarkInvalidMove: '不能把文件夹移入自身或子文件夹。', bookmarkNotEmpty: '只能删除空文件夹。批量删除文件夹内容请使用浏览器书签管理器。',
      bookmarkTitleRequired: '请输入名称。', bookmarkInvalidUrl: '请输入完整的 HTTP 或 HTTPS 网页地址。',
      bookmarkRefreshFailed: '刷新未完成。原生书签可能已保存，请先刷新确认，不要重复提交。',
      bookmarkInvalidItems: '没有可转存的网页。', bookmarkItemMissing: '部分阅读库网页已被删除。', failed: '操作未完成，请刷新后重试。'
    },
    en: {
      openFull: 'Open full library', openFullFailed: 'Could not open the full library. Try again.', loadingCurrent: 'Reading the current page…', currentPage: 'Current page', saveCurrent: 'Add', alreadyBookmarked: 'Bookmarked', unsupportedCurrent: 'Switch to an HTTP or HTTPS page to add it', moreActions: 'More',
      syncSettings: 'Sync settings', permanentHint: 'Kept permanently. Never auto-removed.', expand: 'Expand folder', collapse: 'Collapse folder', pages: 'Pages', morePages: 'More pages', moreFolders: 'More folders', folderStats: '{n} pages · {folders} subfolders', viewStats: '{folders} folders · {n} pages', pageHint: 'Kept in your browser bookmarks', emptyHint: 'Add a page or organize your lasting collection into folders.', addPage: 'Add page', newFolder: 'New folder', connected: 'Browser bookmarks · Connected', notConnected: 'Connect browser bookmarks', needsAttention: 'Bookmark sync needs attention', previewHint: 'Covers and summaries load automatically, reusing Reading library details first. Site placeholders remain when a preview is unavailable.', bookmarkPreviewUnavailable: 'Some sites do not provide a readable preview. Local or site covers were kept.', name: 'Bookmarks', reading: 'Reading', settings: 'Settings', eyebrow: 'KEEP FOR LATER · BROWSER SYNC',
      intro: 'A lasting home for browser bookmarks, separate from the Reading library and never removed by read-page cleanup.',
      syncTitle: 'Two-way browser bookmark sync', syncHint: 'Sync all bookmarks by default, or a folder and its descendants. Disabling sync or changing its scope never deletes browser bookmarks.',
      enable: 'Enable & grant access', disable: 'Disable sync', scope: 'Sync scope', all: 'All bookmarks', applyScope: 'Apply scope', refresh: 'Refresh',
      folders: 'FOLDERS', search: 'Search bookmarks', add: 'Add a page or folder', title: 'Name', url: 'Page URL', destination: 'Destination folder',
      folderHint: 'Leave the URL blank to create a folder; enter a URL to add a page.', addAction: 'Add', empty: 'No bookmarks here yet.', noMatches: 'No matching bookmarks.',
      transfer: 'Save reading items to Bookmarks', transferHint: 'Original reading items are kept. Removing them later will not delete these bookmarks.',
      copy: 'Confirm transfer', transferCount: '{n} pages to save. Enable sync, then choose a destination folder.', transferComplete: 'Transfer complete. Original reading items have been kept.',
      copyResult: 'Added {added}, already present {existing}, failed {failed}.',
      renameFolder: 'Rename folder', removeFolder: 'Delete empty folder', edit: 'Edit', move: 'Move', remove: 'Delete', cancel: 'Cancel', save: 'Save',
      moveTitle: 'Move “{name}”', deleteTitle: 'Delete “{name}”?', deleteHint: 'This also deletes the browser bookmark and cannot be undone. Original reading items are not affected.',
      active: 'Connected to browser bookmarks. Changes in either direction are reflected live.', disabled: 'Not enabled. Bookmarks are shown within the selected scope; the Reading library is never automatically added to browser bookmarks.',
      working: 'Working…', updating: 'Loading remaining bookmarks…', success: 'Saved to browser bookmarks.', count: '{n} pages', readonly: 'Browser-managed / read-only',
      privacy: 'Changes affect this browser directly. Bookmarks are excluded from reading-library wipe, JSON backups and WebDAV; cross-device bookmark sync is handled by the browser.',
      bookmarkPermission: 'Bookmark access is missing. Choose “Enable & grant access”.', bookmarkDisabled: 'Enable bookmark sync first.',
      bookmarkOutOfScope: 'The target was moved, deleted, or is outside the current scope. Refresh and try again.', bookmarkScopeMissing: 'The selected folder no longer exists. Choose a new scope; sync will not fall back to all bookmarks.',
      bookmarkFolderRequired: 'Choose an existing folder.', bookmarkProtected: 'Browser roots, scope roots and managed bookmarks cannot be modified.',
      bookmarkInvalidMove: 'A folder cannot move into itself or a descendant.', bookmarkNotEmpty: 'Only empty folders can be deleted here. Use the browser bookmark manager for recursive deletion.',
      bookmarkTitleRequired: 'Enter a name.', bookmarkInvalidUrl: 'Enter a complete HTTP or HTTPS URL.',
      bookmarkRefreshFailed: 'Refresh did not finish. Native bookmarks may already be saved; refresh to confirm before resubmitting.',
      bookmarkInvalidItems: 'No pages to transfer.', bookmarkItemMissing: 'Some original reading items have been deleted.', failed: 'Could not complete this action. Refresh and try again.'
    }
  };
  const $ = selector => document.querySelector(selector);
  let language = window.LaterOnAppearance?.get().language === 'en' ? 'en' : 'zh-CN', state = { enabled: false, nodes: [], folders: [] }, busy = false, selected = '', scopeDirty = false, feedback = '';
  const CONFIG_KEY = 'laterOnBookmarkConfig', STATE_KEY = 'laterOnBookmarkState', META_KEY = 'laterOnBookmarkStateMeta', PENDING_KEY = 'laterOnQuickSearchPending';
  // The compact panel's first screen holds about a dozen rows; more load on demand.
  const PAGE_FIRST = window.LaterOnBookmarkSidepanel?.enabled ? 12 : 48, PAGE_STEP = window.LaterOnBookmarkSidepanel?.enabled ? 24 : 48;
  let moving = null, pendingIds = [], expanded = new Set(), expansionReady = false, limit = PAGE_FIRST, folderLimit = 24, previewSignature = '', viewResult = { previewIds: [] };
  let compact = null, loaded = false;
  // Paged mode reads bounded views from the device-local IndexedDB snapshot;
  // `state.nodes` is then only the scoped folders plus the current page.
  const LocalIndex = window.LaterOnLocalIndex;
  let paged = false, pageView = null, context = null, queryEpoch = 0, queryRunning = null, queryAgain = false;
  let queryBackground = true, queryNotBefore = 0;
  const VIEW_KEY = window.LaterOnBookmarkSidepanel?.enabled ? 'laterOnBookmarkSidepanelView' : 'laterOnBookmarkView';
  try {
    const values = JSON.parse(new URL(location.href).searchParams.get('items') || '[]');
    if (Array.isArray(values)) pendingIds = [...new Set(values.filter(value => typeof value === 'string'))];
  } catch {}
  const t = (key, params = {}) => (words[language][key] || words[language].failed).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
  // Destinations are derived once per folder snapshot with one Map and a
  // memoized scope walk (previously folders.find per ancestor per control).
  let scopeCache = { key: null };
  function destinations() {
    const folders = state.folders || [];
    const key = paged ? `${state.updatedAt}|${folders.length}` : folders;
    if (scopeCache.key === key && scopeCache.scopeId === state.scopeId) return scopeCache.list;
    const byId = new Map(folders.map(node => [node.id, node])), inside = new Map();
    const within = node => {
      if (!state.scopeId) return true;
      const seen = new Set(), chain = [];
      let result = false;
      for (let current = node; current && !seen.has(current.id); current = byId.get(current.parentId)) {
        if (current.id === state.scopeId) { result = true; break; }
        if (inside.has(current.id)) { result = inside.get(current.id); break; }
        seen.add(current.id); chain.push(current.id);
      }
      for (const id of chain) inside.set(id, result);
      return result;
    };
    scopeCache = { key, scopeId: state.scopeId, list: folders.filter(node => node.writable && within(node)) };
    return scopeCache.list;
  }
  function fillFolders(select, folders, preferred, includeAll = false) {
    const oldValue = preferred ?? select.value;
    // Thousands of options are rebuilt only when the folder snapshot, language
    // or requested value changes; an unchanged rebuild yields the same result.
    if (select.laterOnFolders === folders && select.laterOnLanguage === language && select.value === oldValue && select.options.length) return;
    select.laterOnFolders = folders; select.laterOnLanguage = language;
    select.replaceChildren();
    const option = (value, text) => { const el = document.createElement('option'); el.value = value; el.textContent = text; select.append(el); };
    if (includeAll) option('', t('all'));
    for (const node of folders) option(node.id, node.path || node.title);
    if ([...select.options].some(entry => entry.value === oldValue)) select.value = oldValue;
    else if (oldValue) {
      // A native move/removal must not silently redirect a pending save elsewhere.
      option(oldValue, t('bookmarkFolderRequired'));
      select.lastElementChild.disabled = true;
      select.value = oldValue;
    }
    else if (includeAll) select.value = '';
    else select.value = folders.find(node => node.id === state.scopeId)?.id || folders.find(node => node.folderType === 'other')?.id || folders[0]?.id || '';
  }
  function controls() {
    const available = state.enabled && !state.error, targets = destinations(), targetIds = new Set(targets.map(node => node.id));
    // Before the first real state arrives nothing is known: do not present an
    // empty placeholder as "not enabled" or force the settings open.
    $('#bookmarkEnable').hidden = !loaded || state.enabled && state.error !== 'bookmarkPermission';
    $('#bookmarkEnable').disabled = busy;
    $('#bookmarkDisable').hidden = !state.enabled;
    $('#bookmarkDisable').disabled = busy;
    $('#bookmarkScope').disabled = busy || !state.enabled || state.error === 'bookmarkPermission';
    $('#bookmarkApplyScope').disabled = $('#bookmarkScope').disabled;
    $('#bookmarkRefresh').disabled = busy;
    $('#bookmarkAddPanel').hidden = !available;
    $('#bookmarkAddForm').querySelectorAll('button, input, select').forEach(el => { el.disabled = busy || !available || !targets.length; });
    const validDestination = selector => targetIds.has($(selector).value);
    $('#bookmarkAddForm button').disabled ||= !validDestination('#bookmarkParent');
    $('#bookmarkCopy').disabled = busy || !available || !pendingIds.length || !validDestination('#bookmarkTransferFolder');
    $('#bookmarkTransferFolder').disabled = busy || !available;
    $('#bookmarkList').querySelectorAll('button').forEach(el => { el.disabled = busy || !available || el.dataset.readonly === 'true'; });
    $('#bookmarkMoveForm').querySelectorAll('button, select').forEach(el => { el.disabled = busy || !available; });
    $('#bookmarkMoveForm button[type="submit"]').disabled ||= !validDestination('#bookmarkMoveFolder');
    $('#bookmarkFolderActions').querySelectorAll('button').forEach(el => { el.disabled = busy || !available; });
    const contents = selected && viewResult.model?.byId.has(selected) ? viewResult.model.summary(selected) : null;
    $('#bookmarkRemoveFolder').disabled ||= !!contents && (contents.pending || contents.pages > 0 || contents.folders > 0);
    $('#bookmarkRemoveFolder').title = $('#bookmarkRemoveFolder').disabled ? t('bookmarkNotEmpty') : t('removeFolder');
    $('#bookmarkStatus').textContent = !loaded && !feedback ? '' : busy ? t('working') : feedback || (state.error ? t(state.error) : t(state.enabled ? 'active' : 'disabled'));
    $('#bookmarkStatus').dataset.error = String(!!state.error);
    $('#bookmarkStatus').classList.toggle('visually-hidden', !loaded && !feedback || !busy && !feedback && state.enabled && !state.error);
    if (loaded && (!state.enabled || state.error)) $('#bookmarkSyncSettings').open = true;
    $('#bookmarkConnection').setAttribute('aria-expanded', String($('#bookmarkSyncSettings').open));
    $('#bookmarkConnection').dataset.connected = String(!!available);
    $('#bookmarkConnection').dataset.error = String(!!state.error);
    $('#bookmarkConnectionLabel').textContent = t(!loaded ? 'syncSettings' : state.error ? 'needsAttention' : available ? 'connected' : 'notConnected');
    for (const selector of ['#bookmarkNewPage', '#bookmarkNewFolder']) $(selector).disabled = busy || !available || !targets.length;
    compact?.render({ state, busy, writable: available && targets.length > 0, title: $('#bookmarkViewTitle').textContent, pages: viewResult.totalPages || 0 });
  }
  function persistView() {
    chrome.storage.local.set({ [VIEW_KEY]: { selected, expanded: [...expanded] } }).catch(() => {});
  }
  function navigate(id) {
    selected = id; limit = PAGE_FIRST; folderLimit = 24;
    for (const parent of view.model(state.nodes, state.scopeId, paged).trail(id)) expanded.add(parent.id);
    if (destinations().some(folder => folder.id === selected)) $('#bookmarkParent').value = selected;
    update(); persistView();
    compact?.navigated();
    $('.bookmark-content').scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }
  const view = window.LaterOnBookmarkView.create({ tree: $('#bookmarkFolders'), breadcrumbs: $('#bookmarkBreadcrumbs'),
    boards: $('#bookmarkFolderCards'), list: $('#bookmarkList'), t, onNavigate: navigate,
    onToggle: id => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); persistView(); },
    onEdit: edit, onMove: openMove, onRemove: remove });
  function queueVisiblePreviews() {
    if (window.LaterOnSidepanelSwitch?.isActive() === false || !state.enabled || state.error || !viewResult.model) return;
    const ids = viewResult.previewIds.filter(id => viewResult.model.byId.get(id)?.url);
    const missing = ids.filter(id => {
      const node = viewResult.model.byId.get(id), preview = node?.preview;
      return node?.url && (!preview?.image || !preview?.description) &&
        (!preview?.attemptedAt || Date.now() - preview.attemptedAt >= 24 * 60 * 60 * 1000);
    });
    const viewKey = JSON.stringify([state.scopeId, selected, $('#bookmarkSearch').value.trim(), limit, folderLimit, ids]);
    const signature = JSON.stringify([viewKey, missing]);
    if (signature === previewSignature) return;
    previewSignature = signature;
    // This only promotes durable jobs. It neither waits for all covers nor
    // turns background preview failures into an interrupting status message.
    chrome.runtime.sendMessage({ type: 'BOOKMARKS_PREVIEWS', automatic: true, ids, viewKey }).catch(() => { previewSignature = ''; });
  }
  window.addEventListener('lateron-sidepanel-visible', queueVisiblePreviews);
  function render() {
    const folders = state.folders || [];
    if (state.enabled && selected && !state.nodes.some(node => node.id === selected && !node.url)) selected = '';
    if (!expansionReady && state.nodes.length) {
      expanded = new Set(view.model(state.nodes, state.scopeId, paged).roots.map(node => node.id)); expansionReady = true;
    }
    fillFolders($('#bookmarkScope'), folders, scopeDirty ? $('#bookmarkScope').value : state.scopeId || '', true);
    if (state.scopeId && !folders.some(node => node.id === state.scopeId)) {
      const missing = [...$('#bookmarkScope').options].find(option => option.value === state.scopeId);
      if (missing) missing.textContent = t('bookmarkScopeMissing');
      $('#bookmarkScope').value = state.scopeId;
    }
    for (const select of document.querySelectorAll('.folder-destination')) fillFolders(select, destinations());
    const current = state.nodes.find(node => node.id === selected);
    $('#bookmarkViewTitle').textContent = current?.title || t('all');
    $('#bookmarkFolderActions').hidden = !current || current.protected || current.id === state.scopeId;
    const query = $('#bookmarkSearch').value.trim();
    viewResult = view.render({ nodes: state.nodes, scopeId: state.scopeId, selected, expanded, query, limit, folderLimit,
      view: paged ? pageView : null, showTree: compact ? compact.foldersVisible() : true });
    $('#bookmarkBreadcrumbs').hidden = !selected;
    $('#bookmarkCount').textContent = t('viewStats', { n: viewResult.totalPages, folders: viewResult.totalFolders });
    $('#bookmarkPageCount').textContent = t('count', { n: viewResult.totalPages });
    $('#bookmarkFolderCount').textContent = String(viewResult.totalFolders);
    $('#bookmarkFolderSection').hidden = !viewResult.totalFolders;
    $('#bookmarkPageSection').hidden = !viewResult.totalPages;
    $('#bookmarkMorePages').hidden = viewResult.totalPages <= limit;
    $('#bookmarkMoreFolders').hidden = viewResult.totalFolders <= folderLimit;
    $('#bookmarkEmpty h2').textContent = t(query ? 'noMatches' : 'empty');
    $('#bookmarkEmpty').hidden = !loaded || !!(viewResult.totalPages || viewResult.totalFolders) || !state.enabled || !!state.error;
    if (state.provisional) {
      const updating = t('updating');
      if (!state.view?.countKnown) $('#bookmarkPageCount').textContent = updating;
      $('#bookmarkCount').textContent += ` · ${updating}`;
      $('#bookmarkEmpty').hidden = true;
      $('#bookmarkFolderCards').querySelectorAll('.board-meta').forEach(node => { node.textContent = updating; });
      if (state.view?.hasMore) $('#bookmarkMorePages').hidden = false;
    }
    $('#bookmarkTransfer').hidden = !new URL(location.href).searchParams.has('items');
    $('#bookmarkTransferSummary').textContent = pendingIds.length ? t('transferCount', { n: pendingIds.length }) : t('transferComplete');
    for (const selector of ['label[for="bookmarkTransferFolder"]', '#bookmarkTransferFolder', '#bookmarkCopy']) $(selector).hidden = !pendingIds.length;
    document.title = `LaterOn · ${t('name')}${current ? ` · ${current.title}` : ''}`;
    controls();
    queueVisiblePreviews();
  }
  const pagedAvailable = () => !!LocalIndex?.bookmarkView && context?.bookmarkPermission === true && context.bookmarkConfig?.enabled === true;
  function applyPaged(result) {
    state = result; pageView = result.view; paged = true; loaded = true;
    if (typeof result.view?.selected === 'string') selected = result.view.selected;
    render();
  }
  // Latest-wins bounded query. Only one IndexedDB read runs at a time; input
  // that arrives meanwhile reruns once, and older answers are discarded.
  function refreshPaged({ notBefore = 0, background = false } = {}) {
    if (!background) { try { chrome.runtime.sendMessage?.({ type: 'BOOKMARKS_ACTIVITY' })?.catch?.(() => {}); } catch {} }
    if (!queryRunning) { queryBackground = background; queryNotBefore = notBefore; }
    else { queryBackground &&= background; queryNotBefore = Math.max(queryNotBefore, notBefore); }
    if (queryRunning) { queryAgain = true; return queryRunning; }
    queryRunning = (async () => {
      let applied = false;
      do {
        queryAgain = false;
        const backgroundRequest = queryBackground;
        queryBackground = true;
        const epoch = ++queryEpoch, request = { selected, query: $('#bookmarkSearch').value.trim(), limit, folderLimit };
        let result = null;
        try { result = pagedAvailable() ? await LocalIndex.bookmarkView(request, context) : null; } catch {}
        if (result && ((result.updatedAt || 0) < (context?.facts?.updatedAt || 0)
          || context?.pending?.bookmarks && (context.pending.nativeAt || 0) > (context.facts?.nativeVerifiedAt || 0))) result = null;
        if (!result && pagedAvailable()) {
          try { result = await send({ type: 'BOOKMARKS_VIEW', ...request, background: backgroundRequest }); }
          catch (error) {
            if (error.message === 'bookmarkOutOfScope' && selected) { selected = ''; queryAgain = true; continue; }
            if (['bookmarkPermission', 'bookmarkDisabled', 'bookmarkScopeMissing'].includes(error.message)) {
              useFull({ enabled: context?.bookmarkConfig?.enabled === true, scopeId: context?.bookmarkConfig?.scopeId || null, nodes: [], folders: [], error: error.message });
              render();
            }
          }
        }
        if (queryAgain || epoch !== queryEpoch) continue;
        if (!result || (result.updatedAt || 0) < queryNotBefore) return false;
        applyPaged(result); applied = true;
      } while (queryAgain);
      return applied;
    })().finally(() => { queryRunning = null; });
    return queryRunning;
  }
  // User navigation, search and "more" always ask for a bounded view.
  function update() {
    if (paged && pagedAvailable()) refreshPaged();
    else render();
  }
  function useFull(next) {
    queryEpoch++; state = next; paged = false; pageView = null; loaded = true;
  }
  // A native-bookmark reply is authoritative. Prefer an equally fresh bounded
  // snapshot; otherwise show the reply itself rather than older indexed data.
  async function adopt(next) {
    if (!next) return;
    if (next.enabled === true && context) context.bookmarkConfig = { ...context.bookmarkConfig, enabled: true, scopeId: next.scopeId || null };
    if (next.enabled === false && context) context.bookmarkConfig = { ...context.bookmarkConfig, enabled: false };
    if (next.enabled && !next.error && pagedAvailable() && await refreshPaged({ notBefore: next.updatedAt || 0 })) return;
    useFull(next);
  }
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'failed');
    return result.state;
  }
  async function action(task, success = '') {
    if (busy) return null;
    busy = true; feedback = ''; controls();
    try {
      const wasEnabled = state.enabled;
      const next = await task();
      await adopt(next);
      feedback = state.error ? t(state.error) : success;
      render();
      return next;
    } catch (error) {
      loaded = true; feedback = t(error.message); controls();
      return null;
    } finally { busy = false; controls(); }
  }
  async function edit(node) {
    const fields = [{ name: 'title', label: t('title'), value: node.title, maxLength: 500 }];
    if (node.url) fields.push({ name: 'url', label: t('url'), value: node.url, maxLength: 10000 });
    const result = await window.LaterOnDialog.prompt({ title: t(node.url ? 'edit' : 'renameFolder'), fields, confirmText: t('save') });
    if (result?.ok) await action(() => send({ type: 'BOOKMARKS_UPDATE', id: node.id, ...result.values }), t('success'));
  }
  async function remove(node) {
    const confirmed = await window.LaterOnDialog.confirm({ tone: 'danger', title: t('deleteTitle', { name: node.title || node.url }), message: t('deleteHint'), confirmText: t('remove') });
    if (confirmed) await action(() => send({ type: 'BOOKMARKS_REMOVE', id: node.id }), t('success'));
  }
  function openMove(node) {
    moving = node;
    $('#bookmarkMoveTitle').textContent = t('moveTitle', { name: node.title });
    fillFolders($('#bookmarkMoveFolder'), destinations(), node.parentId);
    $('#bookmarkMoveForm').hidden = false; controls(); $('#bookmarkMoveFolder').focus();
  }
  $('#bookmarkEnable').addEventListener('click', () => {
    if (busy) return;
    // Request directly in the user gesture, before awaiting storage or messages.
    let requested;
    try { requested = chrome.permissions.request({ permissions: ['bookmarks'] }); }
    catch { feedback = t('bookmarkPermission'); controls(); return; }
    action(async () => {
      if (!await requested) throw new Error('bookmarkPermission');
      if (context) context.bookmarkPermission = true;
      return send({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: state.scopeId || null });
    });
  });
  $('#bookmarkDisable').addEventListener('click', () => action(() => send({ type: 'BOOKMARKS_CONFIG', enabled: false })));
  $('#bookmarkScope').addEventListener('change', () => { scopeDirty = true; });
  $('#bookmarkApplyScope').addEventListener('click', () => action(async () => {
    const next = await send({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: $('#bookmarkScope').value || null });
    scopeDirty = false; return next;
  }));
  $('#bookmarkRefresh').addEventListener('click', () => action(() => send({ type: 'BOOKMARKS_GET', force: true })));
  $('#bookmarkSearch').addEventListener('input', () => { limit = PAGE_FIRST; update(); });
  $('#bookmarkMorePages').addEventListener('click', () => { limit += PAGE_STEP; update(); });
  $('#bookmarkMoreFolders').addEventListener('click', () => { folderLimit += 24; update(); });
  function toggleSettings() { $('#bookmarkSyncSettings').open = !$('#bookmarkSyncSettings').open; controls(); }
  $('#bookmarkConnection').addEventListener('click', toggleSettings);
  $('#bookmarkSettingsShortcut').addEventListener('click', toggleSettings);
  $('#bookmarkSyncSettings').addEventListener('toggle', () => $('#bookmarkConnection').setAttribute('aria-expanded', String($('#bookmarkSyncSettings').open)));
  function openAdd(folder) {
    $('#bookmarkAddPanel').open = true;
    $('#bookmarkUrl').value = ''; $('#bookmarkUrl').required = !folder;
    $('#bookmarkUrl').hidden = folder; document.querySelector('label[for="bookmarkUrl"]').hidden = folder;
    $('#bookmarkAddPanel summary').textContent = t(folder ? 'newFolder' : 'addPage');
    $('#bookmarkTitle').focus();
  }
  $('#bookmarkNewPage').addEventListener('click', () => openAdd(false));
  $('#bookmarkNewFolder').addEventListener('click', () => openAdd(true));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#bookmarkSearch').focus(); }
  });
  document.querySelectorAll('.folder-destination').forEach(select => select.addEventListener('change', controls));
  $('#bookmarkAddForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('#bookmarkAddForm').reportValidity()) return;
    const message = { type: 'BOOKMARKS_CREATE', parentId: $('#bookmarkParent').value, title: $('#bookmarkTitle').value };
    if ($('#bookmarkUrl').value.trim()) message.url = $('#bookmarkUrl').value.trim();
    action(async () => {
      const next = await send(message);
      $('#bookmarkTitle').value = ''; $('#bookmarkUrl').value = '';
      return next;
    }, t('success'));
  });
  $('#bookmarkCopy').addEventListener('click', () => action(async () => {
    const next = await send({ type: 'BOOKMARKS_COPY_ITEMS', ids: pendingIds, parentId: $('#bookmarkTransferFolder').value });
    if (next.results) {
      const done = new Set(next.results.successfulIds);
      pendingIds = pendingIds.filter(id => !done.has(id));
      $('#bookmarkTransferResult').textContent = [t('copyResult', { ...next.results, failed: next.results.failed.length }),
        ...next.results.failed.map(item => `${item.title || item.id}: ${t(item.error)}`)].join('\n');
    }
    return next;
  }));
  $('#bookmarkRenameFolder').addEventListener('click', () => { const node = state.nodes.find(node => node.id === selected); if (node) edit(node); });
  $('#bookmarkRemoveFolder').addEventListener('click', () => { const node = state.nodes.find(node => node.id === selected); if (node) remove(node); });
  $('#bookmarkMoveCancel').addEventListener('click', () => { moving = null; $('#bookmarkMoveForm').hidden = true; });
  $('#bookmarkMoveForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!moving) return;
    const id = moving.id, parentId = $('#bookmarkMoveFolder').value;
    action(async () => {
      const next = await send({ type: 'BOOKMARKS_MOVE', id, parentId });
      moving = null; $('#bookmarkMoveForm').hidden = true;
      return next;
    }, t('success'));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let configChanged = false;
    if (changes[CONFIG_KEY] && context) {
      const before = context.bookmarkConfig;
      context.bookmarkConfig = changes[CONFIG_KEY].newValue || { enabled: false, scopeId: null };
      configChanged = before?.enabled !== context.bookmarkConfig.enabled || (before?.scopeId || null) !== (context.bookmarkConfig.scopeId || null);
    }
    if (context && changes[META_KEY]) context.facts = changes[META_KEY].newValue || null;
    if (context && changes[PENDING_KEY]) context.pending = changes[PENDING_KEY].newValue || null;
    if (configChanged) {
      // Scope/disable changes are small metadata-only publications. Remove
      // the old scope's cards immediately, without waiting for a mirror.
      selected = '';
      useFull({ enabled: context.bookmarkConfig.enabled === true, scopeId: context.bookmarkConfig.scopeId || null, nodes: [], folders: [] });
      if (state.enabled) loaded = false;
      feedback = ''; render();
      if (pagedAvailable()) { refreshPaged({ background: true }); return; }
    }
    if (loaded && pagedAvailable() && (changes[META_KEY] || changes[PENDING_KEY])) { refreshPaged({ background: true }); return; }
    const next = changes[STATE_KEY]?.newValue;
    if (!next) return;
    // In paged mode a full state broadcast only triggers a bounded re-read.
    if (next.enabled && !next.error && pagedAvailable()) {
      refreshPaged({ notBefore: paged ? 0 : next.updatedAt || 0, background: true }).then(applied => { if (!applied) { useFull(next); feedback = ''; render(); } });
      return;
    }
    useFull(next); feedback = ''; render();
  });
  chrome.runtime.onMessage?.addListener?.(message => {
    if (message?.type === 'BOOKMARKS_CHANGED' && loaded && pagedAvailable()) refreshPaged({ background: true });
  });
  // Permission changes: confirm the live state, leave the indexed view at once
  // on revocation, and return to it when bookmarks access is granted again.
  let permissionCheck = 0;
  async function permissionChanged(change, added) {
    if (Array.isArray(change?.permissions) && !change.permissions.includes('bookmarks')) return;
    const run = ++permissionCheck;
    if (!added && context) {
      context.bookmarkPermission = false;
      queryEpoch++; paged = false; pageView = null;
      state = { ...state, nodes: [], folders: [], error: 'bookmarkPermission' };
      feedback = ''; render();
    }
    let granted = false;
    try { granted = await chrome.permissions.contains({ permissions: ['bookmarks'] }) === true; } catch {}
    if (run !== permissionCheck || !context) return;
    context.bookmarkPermission = granted;
    if (!granted) {
      if (paged || !state.error) { queryEpoch++; paged = false; pageView = null; state = { ...state, nodes: [], folders: [], error: 'bookmarkPermission' }; render(); }
      return;
    }
    if (added && pagedAvailable() && await refreshPaged()) return;
    if (added) action(() => send({ type: 'BOOKMARKS_GET', force: true }));
  }
  chrome.permissions?.onAdded?.addListener?.(change => { permissionChanged(change, true); });
  chrome.permissions?.onRemoved?.addListener?.(change => { permissionChanged(change, false); });
  compact = window.LaterOnBookmarkSidepanel?.mount({ t, getSelected: () => selected, onFoldersShown: render,
    isBookmarked: async urls => paged && LocalIndex?.membership ? (await LocalIndex.membership(urls, context).catch(() => null))?.matches?.length > 0 : null, onAdd: tab => {
    openAdd(false); $('#bookmarkTitle').value = tab.title || tab.url; $('#bookmarkUrl').value = tab.url;
  }, onError: () => { feedback = t('openFullFailed'); controls(); } });
  // Neutral loading controls immediately (no "not enabled" placeholder).
  controls();
  function applyLanguage() {
    document.documentElement.lang = language;
    document.title = `LaterOn · ${t('name')}`;
    window.LaterOnI18n.applyStatic();
    document.querySelector('.library-switch').setAttribute('aria-label', `${t('reading')} / ${t('name')}`);
    document.querySelector('.bookmark-sidebar').setAttribute('aria-label', t('folders'));
    document.querySelectorAll('[data-bm]').forEach(el => { el.textContent = t(el.dataset.bm); });
    document.querySelectorAll('[data-bm-title]').forEach(el => { el.title = t(el.dataset.bmTitle); el.setAttribute('aria-label', el.title); });
    compact?.relabel();
    $('#bookmarkSearch').setAttribute('aria-label', t('search'));
    $('#bookmarkSearch').placeholder = t('search');
  }
  // Language, saved view, config and permission load in parallel; the
  // side-panel head may already have started the bounded snapshot read.
  const boot = window.LaterOnBookmarkSidepanel?.prefetch?.() || {
    stored: chrome.storage.local.get([VIEW_KEY, CONFIG_KEY, META_KEY, PENDING_KEY]).catch(() => ({})),
    permission: Promise.resolve(chrome.permissions?.contains?.({ permissions: ['bookmarks'] })).catch(() => null), view: Promise.resolve(null)
  };
  const languageReady = Promise.resolve(window.LaterOnI18n.getLanguage()).then(value => {
    language = value === 'en' ? 'en' : 'zh-CN'; applyLanguage(); if (loaded) render();
  });
  (async () => {
    const [values, granted] = await Promise.all([boot.stored, boot.permission]);
    context = { bookmarkPermission: granted === true, bookmarkConfig: values?.[CONFIG_KEY] || { enabled: false, scopeId: null }, facts: values?.[META_KEY], pending: values?.[PENDING_KEY] };
    const saved = values?.[VIEW_KEY];
    if (saved) { selected = typeof saved.selected === 'string' ? saved.selected : ''; if (Array.isArray(saved.expanded)) { expanded = new Set(saved.expanded); expansionReady = true; } }
    const requestedFolder = new URL(location.href).searchParams.get('folder');
    if (requestedFolder !== null) selected = requestedFolder;
    const early = await boot.view;
    if (early?.result && early.request.selected === selected && early.request.limit === limit && !$('#bookmarkSearch').value.trim() && pagedAvailable()) applyPaged(early.result);
    else if (pagedAvailable()) await refreshPaged();
    if (paged) {
      await languageReady.catch(() => {});
      // The cached view is mounted. A small freshness probe lets the worker
      // verify native bookmarks when its last check is old; a real change is
      // re-indexed there and announced as BOOKMARKS_CHANGED (bounded re-read).
      // The full mirror is never requested or copied on this path.
      chrome.runtime.sendMessage({ type: 'BOOKMARKS_CHECK' }).then(reply => {
        const facts = reply?.state || reply;
        if (facts?.changed && (facts.updatedAt || 0) > (state.updatedAt || 0)) refreshPaged({ notBefore: facts.updatedAt, background: true });
      }).catch(() => {});
      return;
    }
    await languageReady.catch(() => {});
    render();
    await action(() => send({ type: 'BOOKMARKS_GET' }));
  })().catch(() => { loaded = true; feedback = t('failed'); controls(); })
    .finally(() => window.LaterOnSidepanelSwitch?.ready());
})();

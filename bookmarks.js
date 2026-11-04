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
      working: '正在处理…', success: '已保存到浏览器书签。', count: '{n} 个网页', readonly: '浏览器管理 / 只读',
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
      working: 'Working…', success: 'Saved to browser bookmarks.', count: '{n} pages', readonly: 'Browser-managed / read-only',
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
  let moving = null, pendingIds = [], expanded = new Set(), expansionReady = false, limit = 48, folderLimit = 24, previewSignature = '', viewResult = { previewIds: [] };
  let compact = null;
  const VIEW_KEY = window.LaterOnBookmarkSidepanel?.enabled ? 'laterOnBookmarkSidepanelView' : 'laterOnBookmarkView';
  try {
    const values = JSON.parse(new URL(location.href).searchParams.get('items') || '[]');
    if (Array.isArray(values)) pendingIds = [...new Set(values.filter(value => typeof value === 'string'))];
  } catch {}
  const t = (key, params = {}) => (words[language][key] || words[language].failed).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
  const withinScope = node => {
    if (!state.scopeId) return true;
    const seen = new Set();
    for (let current = node; current && !seen.has(current.id); current = state.folders.find(entry => entry.id === current.parentId)) {
      if (current.id === state.scopeId) return true;
      seen.add(current.id);
    }
    return false;
  };
  const destinations = () => state.folders.filter(node => node.writable && withinScope(node));
  function fillFolders(select, folders, preferred, includeAll = false) {
    const oldValue = preferred ?? select.value;
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
    const available = state.enabled && !state.error;
    $('#bookmarkEnable').hidden = state.enabled && state.error !== 'bookmarkPermission';
    $('#bookmarkEnable').disabled = busy;
    $('#bookmarkDisable').hidden = !state.enabled;
    $('#bookmarkDisable').disabled = busy;
    $('#bookmarkScope').disabled = busy || !state.enabled || state.error === 'bookmarkPermission';
    $('#bookmarkApplyScope').disabled = $('#bookmarkScope').disabled;
    $('#bookmarkRefresh').disabled = busy;
    $('#bookmarkAddPanel').hidden = !available;
    $('#bookmarkAddForm').querySelectorAll('button, input, select').forEach(el => { el.disabled = busy || !available || !destinations().length; });
    const validDestination = selector => destinations().some(node => node.id === $(selector).value);
    $('#bookmarkAddForm button').disabled ||= !validDestination('#bookmarkParent');
    $('#bookmarkCopy').disabled = busy || !available || !pendingIds.length || !validDestination('#bookmarkTransferFolder');
    $('#bookmarkTransferFolder').disabled = busy || !available;
    $('#bookmarkList').querySelectorAll('button').forEach(el => { el.disabled = busy || !available || el.dataset.readonly === 'true'; });
    $('#bookmarkMoveForm').querySelectorAll('button, select').forEach(el => { el.disabled = busy || !available; });
    $('#bookmarkMoveForm button[type="submit"]').disabled ||= !validDestination('#bookmarkMoveFolder');
    $('#bookmarkFolderActions').querySelectorAll('button').forEach(el => { el.disabled = busy || !available; });
    $('#bookmarkRemoveFolder').disabled ||= state.nodes.some(node => node.parentId === selected);
    $('#bookmarkRemoveFolder').title = $('#bookmarkRemoveFolder').disabled ? t('bookmarkNotEmpty') : t('removeFolder');
    $('#bookmarkStatus').textContent = busy ? t('working') : feedback || (state.error ? t(state.error) : t(state.enabled ? 'active' : 'disabled'));
    $('#bookmarkStatus').dataset.error = String(!!state.error);
    $('#bookmarkStatus').classList.toggle('visually-hidden', !busy && !feedback && state.enabled && !state.error);
    if (!state.enabled || state.error) $('#bookmarkSyncSettings').open = true;
    $('#bookmarkConnection').setAttribute('aria-expanded', String($('#bookmarkSyncSettings').open));
    $('#bookmarkConnection').dataset.connected = String(!!available);
    $('#bookmarkConnection').dataset.error = String(!!state.error);
    $('#bookmarkConnectionLabel').textContent = t(state.error ? 'needsAttention' : available ? 'connected' : 'notConnected');
    for (const selector of ['#bookmarkNewPage', '#bookmarkNewFolder']) $(selector).disabled = busy || !available || !destinations().length;
    compact?.render({ state, busy, writable: available && destinations().length > 0, title: $('#bookmarkViewTitle').textContent, pages: viewResult.totalPages || 0 });
  }
  function persistView() {
    chrome.storage.local.set({ [VIEW_KEY]: { selected, expanded: [...expanded] } }).catch(() => {});
  }
  function navigate(id) {
    selected = id; limit = 48; folderLimit = 24;
    for (const parent of window.LaterOnBookmarkView.index(state.nodes, state.scopeId).trail(id)) expanded.add(parent.id);
    if (destinations().some(folder => folder.id === selected)) $('#bookmarkParent').value = selected;
    render(); persistView();
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
      expanded = new Set(window.LaterOnBookmarkView.index(state.nodes, state.scopeId).roots.map(node => node.id)); expansionReady = true;
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
    viewResult = view.render({ nodes: state.nodes, scopeId: state.scopeId, selected, expanded, query, limit, folderLimit });
    $('#bookmarkBreadcrumbs').hidden = !selected;
    $('#bookmarkCount').textContent = t('viewStats', { n: viewResult.totalPages, folders: viewResult.totalFolders });
    $('#bookmarkPageCount').textContent = t('count', { n: viewResult.totalPages });
    $('#bookmarkFolderCount').textContent = String(viewResult.totalFolders);
    $('#bookmarkFolderSection').hidden = !viewResult.totalFolders;
    $('#bookmarkPageSection').hidden = !viewResult.totalPages;
    $('#bookmarkMorePages').hidden = viewResult.totalPages <= limit;
    $('#bookmarkMoreFolders').hidden = viewResult.totalFolders <= folderLimit;
    $('#bookmarkEmpty h2').textContent = t(query ? 'noMatches' : 'empty');
    $('#bookmarkEmpty').hidden = !!(viewResult.totalPages || viewResult.totalFolders) || !state.enabled || !!state.error;
    $('#bookmarkTransfer').hidden = !new URL(location.href).searchParams.has('items');
    $('#bookmarkTransferSummary').textContent = pendingIds.length ? t('transferCount', { n: pendingIds.length }) : t('transferComplete');
    for (const selector of ['label[for="bookmarkTransferFolder"]', '#bookmarkTransferFolder', '#bookmarkCopy']) $(selector).hidden = !pendingIds.length;
    document.title = `LaterOn · ${t('name')}${current ? ` · ${current.title}` : ''}`;
    controls();
    queueVisiblePreviews();
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
      if (next) state = next;
      if (!wasEnabled && state.enabled && !state.error) $('#bookmarkSyncSettings').open = false;
      feedback = state.error ? t(state.error) : success;
      render();
      return next;
    } catch (error) {
      feedback = t(error.message); controls();
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
      return send({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: state.scopeId || null });
    });
  });
  $('#bookmarkDisable').addEventListener('click', () => action(() => send({ type: 'BOOKMARKS_CONFIG', enabled: false })));
  $('#bookmarkScope').addEventListener('change', () => { scopeDirty = true; });
  $('#bookmarkApplyScope').addEventListener('click', () => action(async () => {
    const next = await send({ type: 'BOOKMARKS_CONFIG', enabled: true, scopeId: $('#bookmarkScope').value || null });
    scopeDirty = false; return next;
  }));
  $('#bookmarkRefresh').addEventListener('click', () => action(() => send({ type: 'BOOKMARKS_GET' })));
  $('#bookmarkSearch').addEventListener('input', () => { limit = 48; render(); });
  $('#bookmarkMorePages').addEventListener('click', () => { limit += 48; render(); });
  $('#bookmarkMoreFolders').addEventListener('click', () => { folderLimit += 24; render(); });
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
    if (area === 'local' && changes.laterOnBookmarkState?.newValue) {
      state = changes.laterOnBookmarkState.newValue; feedback = ''; render();
    }
  });
  compact = window.LaterOnBookmarkSidepanel?.mount({ t, getSelected: () => selected, onAdd: tab => {
    openAdd(false); $('#bookmarkTitle').value = tab.title || tab.url; $('#bookmarkUrl').value = tab.url;
  }, onError: () => { feedback = t('openFullFailed'); controls(); } });
  (async () => {
    language = await window.LaterOnI18n.getLanguage();
    if (language !== 'en') language = 'zh-CN';
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
    const saved = (await chrome.storage.local.get(VIEW_KEY))[VIEW_KEY];
    if (saved) { selected = typeof saved.selected === 'string' ? saved.selected : ''; if (Array.isArray(saved.expanded)) { expanded = new Set(saved.expanded); expansionReady = true; } }
    const requestedFolder = new URL(location.href).searchParams.get('folder');
    if (requestedFolder !== null) selected = requestedFolder;
    render();
    await action(() => send({ type: 'BOOKMARKS_GET' }));
  })().catch(() => { feedback = t('failed'); controls(); })
    .finally(() => window.LaterOnSidepanelSwitch?.ready());
})();

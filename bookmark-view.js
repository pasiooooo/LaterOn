(() => {
  function index(nodes, scopeId = null) {
    const byId = new Map(nodes.map(node => [node.id, node])), children = new Map(), summaries = new Map();
    for (const node of nodes) { if (!children.has(node.parentId)) children.set(node.parentId, []); children.get(node.parentId).push(node); }
    const roots = nodes.filter(node => !node.url && (node.id === scopeId || !byId.has(node.parentId)));
    function summary(id, seen = new Set()) {
      if (summaries.has(id)) return summaries.get(id);
      if (seen.has(id)) return { pages: 0, folders: 0, previews: [] };
      seen.add(id);
      const result = { pages: 0, folders: 0, previews: [] };
      for (const node of children.get(id) || []) {
        if (node.url) { result.pages++; result.previews.push(node); }
        else {
          const nested = summary(node.id, seen);
          result.pages += nested.pages; result.folders += nested.folders + 1;
          result.previews.push(...nested.previews);
        }
        result.previews = result.previews.sort((a,b) => Number(!!localImage(b.preview?.image)) - Number(!!localImage(a.preview?.image))).slice(0, 3);
      }
      summaries.set(id, result); seen.delete(id); return result;
    }
    for (const root of roots) summary(root.id);
    const allPages = nodes.filter(node => node.url);
    function pages(id, recursive) {
      if (!id) return allPages;
      if (!recursive) return (children.get(id) || []).filter(node => node.url);
      const result = [], stack = [...children.get(id) || []].reverse(), seen = new Set();
      while (stack.length) {
        const node = stack.pop();
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        if (node.url) result.push(node); else stack.push(...(children.get(node.id) || []).slice().reverse());
      }
      return result;
    }
    function trail(id) {
      const result = [], seen = new Set();
      for (let node = byId.get(id); node && !seen.has(node.id); node = byId.get(node.parentId)) { seen.add(node.id); result.unshift(node); }
      return result;
    }
    return { byId, children, roots, summary, pages, trail };
  }
  const paths = {
    folder: 'M3 7h7l2 2h9v11H3zM3 7V4h7l2 3',
    bookmark: 'M6 3h12v18l-6-4-6 4z',
    chevron: 'm9 5 7 7-7 7',
    edit: 'M4 20h4L20 8l-4-4L4 16zM14 6l4 4',
    move: 'M3 7h7l2 2h9v11H3zM10 14h7m-3-3 3 3-3 3',
    remove: 'M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m3 0-1 13H7L6 7'
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name] || paths.folder); svg.append(path); return svg;
  }
  const localImage = value => typeof value === 'string' && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(value) ? value : '';
  function cover(node, className = '') {
    const cell = document.createElement('div'); cell.className = `bookmark-preview ${className}`;
    let host = '';
    try { host = new URL(node.url).hostname.replace(/^www\./, ''); } catch {}
    const mark = document.createElement('span'); mark.className = 'bookmark-site-mark'; mark.textContent = (host || node.title || 'B').slice(0, 1).toUpperCase(); mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'bookmark-site-label'; label.textContent = host;
    let hash = 0; for (const letter of host) hash = (hash * 31 + letter.charCodeAt(0)) | 0;
    cell.dataset.tone = String(Math.abs(hash) % 5); cell.append(mark, label);
    const image = localImage(node.preview?.image);
    if (image) {
      const img = document.createElement('img'); img.src = image; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('error', () => img.remove()); cell.append(img);
    }
    return cell;
  }
  function create(options) {
    const { tree, breadcrumbs, boards, list, t } = options;
    let cachedNodes, cachedScope, model;
    function render({ nodes, scopeId, selected = '', expanded = new Set(), query = '', limit = 48, folderLimit = 24 }) {
      if (cachedNodes !== nodes || cachedScope !== scopeId) { cachedNodes = nodes; cachedScope = scopeId; model = index(nodes, scopeId); }
      const focused = document.activeElement?.closest?.('[data-folder-id]')?.dataset.folderId;
      const queryText = query.trim().toLocaleLowerCase();
      const pathFor = node => model.trail(node.url ? node.parentId : node.id).map(folder => folder.title).join(' / ');
      const matches = node => `${node.title || ''} ${node.url || ''} ${pathFor(node)} ${node.preview?.description || ''}`.toLocaleLowerCase().includes(queryText);
      const button = (text, handler, className) => {
        const el = document.createElement('button'); el.type = 'button'; el.className = className || ''; el.textContent = text; el.addEventListener('click', handler); return el;
      };
      tree.replaceChildren();
      const all = button(t('all'), () => options.onNavigate(''), 'bookmark-folder-nav bookmark-all');
      all.prepend(icon('bookmark')); all.setAttribute('aria-current', String(!selected)); tree.append(all);
      function branch(folder, depth) {
        const item = document.createElement('li'); item.dataset.folderId = folder.id;
        const row = document.createElement('div'); row.className = 'bookmark-tree-row'; row.style.setProperty('--folder-depth', String(depth));
        const subfolders = (model.children.get(folder.id) || []).filter(node => !node.url);
        const toggle = button('', () => options.onToggle(folder.id), 'bookmark-folder-toggle'); toggle.append(icon('chevron'));
        toggle.disabled = !subfolders.length; toggle.setAttribute('aria-label', `${t(expanded.has(folder.id) ? 'collapse' : 'expand')}: ${folder.title}`);
        toggle.setAttribute('aria-expanded', String(expanded.has(folder.id))); row.append(toggle);
        const select = button('', () => options.onNavigate(folder.id), 'bookmark-folder-nav');
        const thumb = document.createElement('span'); thumb.className = 'bookmark-folder-thumb';
        const preview = model.summary(folder.id).previews.find(node => localImage(node.preview?.image));
        if (preview) thumb.append(cover(preview)); else thumb.append(icon('folder'));
        const name = document.createElement('span'); name.className = 'bookmark-folder-label'; name.textContent = folder.title; name.title = folder.title;
        const count = document.createElement('span'); count.className = 'bookmark-folder-count'; count.textContent = String(model.summary(folder.id).pages);
        select.append(thumb, name, count); select.setAttribute('aria-current', String(selected === folder.id));
        select.title = pathFor(folder);
        row.append(select); item.append(row);
        if (subfolders.length) {
          const group = document.createElement('ul'); group.hidden = !expanded.has(folder.id);
          if (expanded.has(folder.id)) for (const child of subfolders) group.append(branch(child, depth + 1));
          item.append(group);
        }
        return item;
      }
      const roots = document.createElement('ul');
      for (const folder of model.roots) roots.append(branch(folder, 0));
      tree.append(roots);
      if (focused !== undefined) [...tree.querySelectorAll('li[data-folder-id]')].find(node => node.dataset.folderId === focused)?.querySelector('.bookmark-folder-nav')?.focus({ preventScroll: true });
      breadcrumbs.replaceChildren();
      const trail = [{ id: '', title: t('all') }, ...model.trail(selected)];
      trail.forEach((node, position) => {
        if (position) { const divider = document.createElement('span'); divider.className = 'bookmark-breadcrumb-separator'; divider.textContent = '/'; divider.setAttribute('aria-hidden', 'true'); breadcrumbs.append(divider); }
        const crumb = button(node.title, () => options.onNavigate(node.id), 'bookmark-breadcrumb');
        if (position === trail.length - 1) crumb.setAttribute('aria-current', 'page'); breadcrumbs.append(crumb);
      });
      const folderNodes = (selected ? model.children.get(selected) || [] : model.roots).filter(node => !node.url && (!queryText || matches(node)));
      boards.replaceChildren();
      for (const node of folderNodes.slice(0, folderLimit)) {
        const board = button('', () => options.onNavigate(node.id), 'board-card bookmark-folder-card'); board.dataset.id = node.id; board.title = node.title;
        const mosaic = document.createElement('div'); mosaic.className = 'board-cover';
        const summary = model.summary(node.id), previews = summary.previews;
        mosaic.dataset.count = String(previews.length);
        if (previews.length) for (const page of previews) mosaic.append(cover(page, 'board-cell'));
        else { const empty = document.createElement('div'); empty.className = 'bookmark-folder-empty'; empty.append(icon('folder')); mosaic.append(empty); }
        const body = document.createElement('div'); body.className = 'board-body';
        const title = document.createElement('h3'); title.className = 'board-name'; title.textContent = node.title;
        const meta = document.createElement('p'); meta.className = 'board-meta'; meta.textContent = t('folderStats', { n: summary.pages, folders: summary.folders });
        body.append(title, meta); board.append(mosaic, body); boards.append(board);
      }
      let pages = model.pages(selected, !!queryText).filter(node => !queryText || matches(node));
      if (!selected && !queryText) pages = pages.slice().sort((a,b) => (b.dateAdded || 0) - (a.dateAdded || 0));
      list.replaceChildren();
      for (const node of pages.slice(0, limit)) {
        const card = document.createElement('article'); card.className = 'card bookmark-card bookmark-row'; card.dataset.id = node.id;
        const safe = /^https?:\/\//i.test(node.url);
        const link = className => {
          const el = document.createElement(safe ? 'a' : 'div'); el.className = className;
          if (safe) { el.href = node.url; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
          return el;
        };
        const coverLink = link('cover-link'), image = cover(node, 'cover'); coverLink.append(image);
        const actions = document.createElement('div'); actions.className = 'bookmark-actions';
        for (const [name, handler] of [['edit', options.onEdit], ['move', options.onMove], ['remove', options.onRemove]]) {
          const action = button('', () => handler(node)); action.append(icon(name)); action.dataset.action = name; action.dataset.readonly = String(!!node.protected);
          action.title = t(name); action.setAttribute('aria-label', `${t(name)}: ${node.title || node.url}`); actions.append(action);
        }
        const body = document.createElement('div'); body.className = 'card-body';
        const source = document.createElement('div'); source.className = 'source-row';
        try { source.textContent = new URL(node.url).hostname.replace(/^www\./, ''); } catch { source.textContent = t('name'); }
        const titleLink = link('title-link'), heading = document.createElement('h2'); heading.textContent = node.title || node.url; heading.title = heading.textContent; titleLink.append(heading);
        const description = document.createElement('p'); description.className = 'description'; description.textContent = node.preview?.description || t('pageHint');
        const footer = document.createElement('footer');
        const folder = button(model.byId.get(node.parentId)?.title || t('all'), () => options.onMove(node), 'bookmark-card-folder'); folder.title = pathFor(node);
        folder.dataset.readonly = String(!!node.protected); folder.prepend(icon('folder')); footer.append(folder);
        body.append(source, titleLink, description, footer); card.append(coverLink, actions, body); list.append(card);
      }
      const previewIds = [...new Set([...folderNodes.slice(0, folderLimit).flatMap(node => model.summary(node.id).previews), ...pages.slice(0, limit)].map(node => node.id))];
      return { totalPages: pages.length, totalFolders: folderNodes.length, shownPages: Math.min(limit, pages.length), previewIds, model };
    }
    return { render };
  }
  window.LaterOnBookmarkView = { index, create };
})();

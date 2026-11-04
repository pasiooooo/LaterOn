// Local, presentation-only search. Build again when collection storage changes;
// neither this index nor its transient scores belong in backups or sync data.
(() => {
  const prepared = new WeakMap();
  const text = (value, maximum = 1000) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
  const fold = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const unique = (list, value) => { if (value && !list.includes(value)) list.push(value); };
  const timestamp = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  function pageUrl(value) {
    try {
      const url = new URL(value);
      // Keep query values and anchors: separate saved searches and sections
      // must not collapse just because reading navigation ignores them.
      return /^https?:$/.test(url.protocol) && !/^https?:\/\/[^/]*@/.test(url.href) ? url.href : '';
    } catch { return ''; }
  }
  function decoded(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }
  function bookmarkTitle(node, derived) {
    const title = text(node.title);
    if (!derived) return title || node.url;
    const compact = value => fold(value).replace(/[\s·|—–:：_-]+/g, '');
    const label = compact(title), engine = compact(derived.slice(derived.lastIndexOf(' - ') + 3));
    const generic = value => /^(?:search(?:results?)?|搜索(?:结果)?|检索(?:结果)?)$/.test(value);
    const weak = !title || pageUrl(title) === pageUrl(node.url) || label === engine || generic(label)
      || label.startsWith(engine) && generic(label.slice(engine.length))
      || label.endsWith(engine) && generic(label.slice(0, -engine.length));
    return weak ? derived : title;
  }
  function fields(entry) {
    const title = fold(entry.title), aliases = (entry.aliases || []).map(fold).filter(value => value !== title);
    return { title, aliases, source: fold(entry.source), url: fold(decoded(entry.url)),
      locations: [...entry.projectNames || [], ...entry.folderNames || []].map(fold),
      inbox: entry.readingIds?.length && !entry.projectNames?.length ? '等待整理 inbox' : '' };
  }
  function build({ items = [], projects = [], bookmarks = {}, bookmarkConfig = {} } = {}) {
    const all = new Map(), names = new Map((Array.isArray(projects) ? projects : []).filter(Boolean).map(project => [project.id, text(project.name, 500)]));
    const priorities = new Map();
    function record(url) {
      if (!all.has(url)) {
        const host = new URL(url).hostname.replace(/^www\./, '');
        all.set(url, { id: `page:${url}`, url, title: host, source: host, readingIds: [], bookmarkIds: [], projectNames: [], folderNames: [], aliases: [], savedAt: 0 });
      }
      return all.get(url);
    }
    function choose(entry, title, priority) {
      const value = text(title);
      if (!value) return;
      unique(entry.aliases, value);
      if (priority > (priorities.get(entry.url) || 0)) { entry.title = value; priorities.set(entry.url, priority); }
    }
    for (const item of Array.isArray(items) ? items : []) {
      if (!item) continue;
      const url = pageUrl(item.url);
      if (!url) continue;
      const entry = record(url), derived = globalThis.LaterOnUrl?.searchTitle?.(url) || '';
      choose(entry, !item.titleEdited && derived || item.title || url, item.titleEdited ? 4 : 2);
      unique(entry.aliases, text(item.title)); unique(entry.aliases, derived);
      unique(entry.readingIds, item.id == null ? '' : String(item.id));
      unique(entry.projectNames, names.get(item.projectId));
      if (text(item.source, 200)) entry.source = text(item.source, 200);
      entry.savedAt = Math.max(entry.savedAt, timestamp(item.savedAt));
    }
    const enabled = bookmarkConfig?.enabled === true && bookmarks?.enabled === true && !bookmarks.error
      && (bookmarkConfig.scopeId || null) === (bookmarks.scopeId || null);
    if (enabled) {
      const nodes = (Array.isArray(bookmarks.nodes) ? bookmarks.nodes : []).filter(Boolean);
      const byId = new Map([...(Array.isArray(bookmarks.folders) ? bookmarks.folders : []), ...nodes].filter(Boolean).map(node => [node.id, node]));
      const paths = new Map(), scopes = new Map();
      function scoped(node) {
        if (!bookmarkConfig.scopeId) return true;
        if (scopes.has(node.id)) return scopes.get(node.id);
        const seen = new Set(), chain = [];
        let inside = false;
        for (let current = node; current && !seen.has(current.id); current = byId.get(current.parentId)) {
          if (current.id === bookmarkConfig.scopeId) { inside = true; break; }
          if (scopes.has(current.id)) { inside = scopes.get(current.id); break; }
          seen.add(current.id); chain.push(current.id);
        }
        for (const id of chain) scopes.set(id, inside);
        return inside;
      }
      function folderPath(parentId) {
        if (paths.has(parentId)) return paths.get(parentId);
        const parts = [], seen = new Set();
        for (let node = byId.get(parentId); node && !seen.has(node.id); node = byId.get(node.parentId)) {
          seen.add(node.id);
          if (!node.url && text(node.title, 500)) parts.unshift(text(node.title, 500));
        }
        const path = parts.join(' / '); paths.set(parentId, path); return path;
      }
      for (const node of nodes) {
        const url = pageUrl(node.url);
        if (!url || !scoped(node)) continue;
        const entry = record(url), derived = globalThis.LaterOnUrl?.searchTitle?.(url) || '';
        const title = bookmarkTitle(node, derived);
        choose(entry, title, title !== derived && text(node.title) && pageUrl(node.title) !== url ? 3 : 1);
        unique(entry.aliases, text(node.title)); unique(entry.aliases, derived);
        unique(entry.bookmarkIds, node.id == null ? '' : String(node.id));
        unique(entry.folderNames, folderPath(node.parentId));
        entry.savedAt = Math.max(entry.savedAt, timestamp(node.dateAdded));
      }
    }
    const index = [...all.values()].sort((a, b) => b.savedAt - a.savedAt || a.url.localeCompare(b.url));
    prepared.set(index, index.map(fields));
    return index;
  }
  function containsScore(value, term, exact, prefix, inside) {
    const position = value.indexOf(term);
    return position < 0 ? 0 : value === term ? exact : position === 0 ? prefix : inside + (/[^\p{L}\p{N}]/u.test(value[position - 1]) ? 8 : 0);
  }
  function fuzzyScore(value, term) {
    // Fuzzy Latin matching is useful for names such as "Obsidian" -> "obsdn".
    // Short terms, CJK and URL punctuation remain literal to avoid noisy hits.
    if (!/^[a-z0-9]{3,32}$/.test(term)) return 0;
    let best = 0;
    for (let start = value.indexOf(term[0]); start >= 0; start = value.indexOf(term[0], start + 1)) {
      if (start && /[a-z0-9]/.test(value[start - 1])) continue;
      let position = start;
      for (let index = 1; index < term.length && position >= 0; index++) position = value.indexOf(term[index], position + 1);
      if (position < 0) continue;
      const span = position - start + 1;
      if (span <= term.length * 3 + 2) best = Math.max(best, 45 - Math.min(25, span - term.length));
    }
    return best;
  }
  function search(index, query, { limit = 50 } = {}) {
    const entries = Array.isArray(index) ? index : [];
    let normalized = prepared.get(entries);
    if (!normalized) { normalized = entries.map(fields); prepared.set(entries, normalized); }
    const phrase = fold(text(query, 512)), terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];
    const found = [];
    for (let position = 0; position < entries.length; position++) {
      const entry = entries[position], values = normalized[position];
      let score = 0, matches = true;
      for (const term of terms) {
        let part = containsScore(values.title, term, 260, 220, 160);
        for (const alias of values.aliases) part = Math.max(part, containsScore(alias, term, 200, 175, 135));
        part = Math.max(part, containsScore(values.source, term, 115, 105, 95), containsScore(values.url, term, 85, 75, 60));
        for (const location of values.locations) part = Math.max(part, containsScore(location, term, 110, 95, 80));
        if (values.inbox.includes(term)) part = Math.max(part, 80);
        if (!part) {
          part = fuzzyScore(values.title, term);
          for (const alias of values.aliases) part = Math.max(part, Math.max(0, fuzzyScore(alias, term) - 5));
        }
        if (!part) { matches = false; break; }
        score += part;
      }
      if (!matches) continue;
      if (phrase) score += containsScore(values.title, phrase, 700, 350, 150);
      found.push({ entry, score, position });
    }
    found.sort((a, b) => b.score - a.score || b.entry.savedAt - a.entry.savedAt || a.position - b.position);
    const maximum = Number.isFinite(Number(limit)) ? Math.max(0, Math.min(100, Math.floor(Number(limit)))) : 50;
    return { results: found.slice(0, maximum).map(({ entry, score }) => ({ ...entry, score })), total: found.length };
  }
  globalThis.LaterOnQuickSearch = { build, search };
})();

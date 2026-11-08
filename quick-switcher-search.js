// Local, presentation-only search. Build again when collection storage changes;
// neither this index nor its transient scores belong in backups or sync data.
(() => {
  const prepared = new WeakMap();
  const recentOrder = new WeakSet();
  let channel = null, lastYield = 0;
  const turns = [];
  const now = () => typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  // Bulk index work yields at least every few milliseconds, at background
  // priority, so worker messages (show, search, open) run first. Do not use
  // scheduler.yield(): its continuation is boosted ahead of ordinary tasks,
  // which can starve extension messages for seconds during a large build.
  const BUDGET = 6, BACKGROUND_WAIT = 32;
  function yieldTask() {
    if (now() - lastYield < BUDGET) return Promise.resolve();
    const done = () => { lastYield = now(); };
    if (typeof globalThis.scheduler?.postTask === 'function') {
      // A background task can remain queued indefinitely in a busy worker.
      // An ordinary timer bounds this pause without removing CPU yields or
      // promoting every maintenance continuation ahead of worker messages.
      return new Promise(resolve => {
        let settled = false, controller = null;
        const finish = () => {
          if (settled) return;
          settled = true; clearTimeout(timer); done(); resolve();
        };
        const timer = setTimeout(() => {
          finish();
          try { controller?.abort(); } catch {}
        }, BACKGROUND_WAIT);
        try {
          if (typeof globalThis.AbortController === 'function') controller = new globalThis.AbortController();
          Promise.resolve(globalThis.scheduler.postTask(finish, { priority: 'background', ...(controller ? { signal: controller.signal } : {}) })).catch(finish);
        } catch { finish(); }
      });
    }
    if (typeof MessageChannel === 'function') {
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = () => turns.shift()?.();
        channel.port1.unref?.(); channel.port2.unref?.();
      }
      return new Promise(resolve => { turns.push(() => { done(); resolve(); }); channel.port2.postMessage(null); });
    }
    return new Promise(resolve => setTimeout(() => { done(); resolve(); }, 0));
  }
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
  function* construct({ items = [], projects = [], bookmarks = {}, bookmarkConfig = {}, sources = ['reading', 'bookmarks'] } = {}) {
    const selected = new Set(Array.isArray(sources) ? sources : ['reading', 'bookmarks']);
    const all = new Map(), names = new Map((selected.has('reading') && Array.isArray(projects) ? projects : []).filter(Boolean).map(project => [project.id, text(project.name, 500)]));
    const priorities = new Map();
    let work = 0;
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
    for (const item of selected.has('reading') && Array.isArray(items) ? items : []) {
      if (++work % 250 === 0) yield;
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
    const enabled = selected.has('bookmarks') && bookmarkConfig?.enabled === true && bookmarks?.enabled === true && !bookmarks.error
      && (bookmarkConfig.scopeId || null) === (bookmarks.scopeId || null);
    if (enabled) {
      const nodes = (Array.isArray(bookmarks.nodes) ? bookmarks.nodes : []).filter(Boolean);
      const byId = new Map();
      for (const node of [...(Array.isArray(bookmarks.folders) ? bookmarks.folders : []), ...nodes]) {
        if (++work % 250 === 0) yield;
        if (node) byId.set(node.id, node);
      }
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
        if (++work % 250 === 0) yield;
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
    const normalized = [];
    for (const entry of index) {
      if (++work % 250 === 0) yield;
      normalized.push(fields(entry));
    }
    prepared.set(index, normalized);
    recentOrder.add(index);
    return index;
  }
  function build(input) {
    const iterator = construct(input);
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
  }
  async function buildAsync(input, pause = yieldTask) {
    const iterator = construct(input);
    let step = iterator.next();
    while (!step.done) { await pause(); step = iterator.next(); }
    return step.value;
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
  const maximumFor = limit => Number.isFinite(Number(limit)) ? Math.max(0, Math.min(100, Math.floor(Number(limit)))) : 50;
  function score(entry, values, phrase, terms) {
    let score = 0;
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
      if (!part) return null;
      score += part;
    }
    if (phrase) score += containsScore(values.title, phrase, 700, 350, 150);
    return score;
  }
  function searchRecords(records, query, { limit = 50 } = {}) {
    const phrase = fold(text(query, 512)), terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];
    const maximum = maximumFor(limit), found = [];
    const compare = (a, b) => b.score - a.score || b.entry.savedAt - a.entry.savedAt || a.position - b.position;
    let total = 0;
    for (const record of records) {
      const value = score(record.entry, record.values, phrase, terms);
      if (value === null) continue;
      total++;
      if (!maximum) continue;
      const hit = { entry: record.entry, score: value, position: record.position };
      // Keep only the requested winners. Sorting every matching page makes a
      // broad one-letter query progressively slower as the library grows.
      if (found.length === maximum && compare(hit, found[found.length - 1]) >= 0) continue;
      let low = 0, high = found.length;
      while (low < high) { const middle = (low + high) >>> 1; if (compare(hit, found[middle]) < 0) high = middle; else low = middle + 1; }
      found.splice(low, 0, hit);
      if (found.length > maximum) found.pop();
    }
    return { results: found.map(({ entry, score }) => ({ ...entry, score })), total };
  }
  function search(index, query, options = {}) {
    const entries = Array.isArray(index) ? index : [];
    if (!text(query, 512) && recentOrder.has(entries)) {
      return { results: entries.slice(0, maximumFor(options.limit === undefined ? 50 : options.limit)).map(entry => ({ ...entry, score: 0 })), total: entries.length };
    }
    let normalized = prepared.get(entries);
    if (!normalized) { normalized = entries.map(fields); prepared.set(entries, normalized); }
    return searchRecords(entries.map((entry, position) => ({ entry, position, values: normalized[position] })), query, options);
  }
  function preparedFields(index) {
    let normalized = prepared.get(index);
    if (!normalized) { normalized = index.map(fields); prepared.set(index, normalized); }
    return normalized;
  }
  // Tabs are a native session model. This API is never used by a persistent
  // library writer and retains neither page bodies nor favIconUrl payloads.
  function tabUrl(value) {
    try { return typeof value === 'string' && value ? new URL(value).href : ''; } catch { return ''; }
  }
  function buildTabs(tabs = []) {
    const all = new Map();
    const ordered = [...tabs].filter(tab => Number.isInteger(tab?.id) && tab.id >= 0)
      .sort((a, b) => timestamp(b.lastAccessed) - timestamp(a.lastAccessed) || Number(b.active) - Number(a.active) || a.id - b.id);
    for (const tab of ordered) {
      const url = tabUrl(tab.pendingUrl || tab.url); if (!url) continue;
      let entry = all.get(url);
      if (!entry) {
        const parsed = new URL(url), source = parsed.hostname.replace(/^www\./, '') || parsed.protocol.slice(0, -1);
        entry = { id: `tab:${tab.id}:${encodeURIComponent(url)}`, url, title: text(tab.title) || url, source,
          tabIds: [], readingIds: [], bookmarkIds: [], projectNames: [], folderNames: [], aliases: [], savedAt: 0 };
        all.set(url, entry);
      }
      unique(entry.tabIds, tab.id); unique(entry.aliases, text(tab.title));
      entry.savedAt = Math.max(entry.savedAt, timestamp(tab.lastAccessed));
    }
    const index = [...all.values()]; prepared.set(index, index.map(fields)); recentOrder.add(index); return index;
  }
  function matchAll(index, query) {
    const phrase = fold(text(query, 512)), terms = [...new Set(phrase.split(/\s+/).filter(Boolean))];
    const normalized = preparedFields(index), hits = [];
    for (let i = 0; i < index.length; i++) {
      const value = score(index[i], normalized[i], phrase, terms);
      if (value !== null) hits.push({ ...index[i], score: value });
    }
    return hits;
  }
  function mergeTabs(tabIndex, lookupEntries = [], sources = ['tabs', 'reading', 'bookmarks']) {
    const byUrl = new Map(lookupEntries.map(row => [row.entry?.url, row]));
    const index = [], normalized = [];
    for (const tab of tabIndex) {
      const lookup = byUrl.get(tab.url), library = lookup?.entry;
      if (!library) { index.push(tab); normalized.push(fields(tab)); continue; }
      const entry = { ...library, tabIds: [...tab.tabIds],
        readingIds: sources.includes('reading') ? [...(library.readingIds || [])] : [],
        bookmarkIds: sources.includes('bookmarks') ? [...(library.bookmarkIds || [])] : [],
        projectNames: sources.includes('reading') ? [...(library.projectNames || [])] : [],
        folderNames: sources.includes('bookmarks') ? [...(library.folderNames || [])] : [],
        aliases: [...new Set([...(library.aliases || []), tab.title, ...tab.aliases])], savedAt: Math.max(library.savedAt || 0, tab.savedAt) };
      const values = lookup.values || fields(library), native = fields(tab);
      index.push(entry); normalized.push({ ...values, aliases: [...new Set([...(values.aliases || []), native.title, ...native.aliases])] });
    }
    prepared.set(index, normalized); return index;
  }
  function rankScored(entries, { limit = 50 } = {}) {
    return entries.map((entry, position) => ({ entry, position })).sort((a, b) => b.entry.score - a.entry.score
      || (b.entry.savedAt || 0) - (a.entry.savedAt || 0) || a.entry.url.localeCompare(b.entry.url) || a.position - b.position)
      .slice(0, maximumFor(limit)).map(hit => hit.entry);
  }
  globalThis.LaterOnQuickSearch = { build, buildAsync, search, searchRecords, fields, preparedFields, fold, text, yieldTask,
    pageUrl, tabUrl, buildTabs, matchAll, mergeTabs, rankScored };
})();

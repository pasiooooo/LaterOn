// Disposable, device-local indexes. Source data remains in Chrome storage and
// native bookmarks; this database is never part of Reading backups or WebDAV.
(() => {
  const DB = 'lateron-local-index-v1', SCHEMA = 5;
  const QUERY_BLOCK_SIZE = 256;
  // Snapshots are generation-tagged rows. A build writes a new generation in
  // short transactions (bounded rows and bytes), then publishes it by updating
  // one small metadata record; old generations are removed afterwards, also
  // in short transactions. Readers always use the published generation, so
  // a rebuild never blocks or empties the snapshot that is being served.
  const META = { search: 'searchMeta', bookmarks: 'bookmarkMeta' };
  const DATA = { search: ['records', 'postings', 'searchQueries'],
    bookmarks: ['bookmarkNodes', 'bookmarkTerms', 'bookmarkQueries', 'bookmarkTermExtras'] };
  const CHUNK_ROWS = 500, CHUNK_BYTES = 1 << 20, SWEEP_KEYS = 500, LEASE = 120000;
  // A Quick posting list longer than this filters too little to be worth its
  // bytes: queries use the light column scan for such terms anyway. Small
  // libraries keep every list.
  const DENSE_POSTING_MIN = 2048, DENSE_POSTING_SHARE = 5;
  const KEEPALIVE = 20000;
  const MAX = Number.MAX_SAFE_INTEGER;
  let opening = null;
  let channel = null;
  const turns = [];
  // Chrome stops an idle service worker after ~30 s, and IndexedDB work and
  // timers do not count as activity, so a long build would die part-way. A
  // cheap extension call at the start (a delayed build may begin close to that
  // limit) and every ~20 s keeps it alive. Nothing runs between builds.
  let keepers = 0, keepTimer = null;
  function keepAlive() {
    const runtime = globalThis.chrome?.runtime;
    if (typeof runtime?.getPlatformInfo !== 'function' || typeof setTimeout !== 'function') return () => {};
    const ping = () => {
      keepTimer = null;
      try { runtime.getPlatformInfo()?.catch?.(() => {}); } catch {}
      if (keepers > 0) schedule();
    };
    const schedule = () => { keepTimer = setTimeout(ping, KEEPALIVE); keepTimer?.unref?.(); };
    if (keepers++ === 0) ping();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--keepers === 0 && keepTimer) { clearTimeout(keepTimer); keepTimer = null; }
    };
  }
  async function whileActive(work) {
    const stop = keepAlive();
    try { return await work(); } finally { stop(); }
  }
  function yieldTask() {
    if (globalThis.LaterOnQuickSearch?.yieldTask) return globalThis.LaterOnQuickSearch.yieldTask();
    if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
    if (typeof MessageChannel === 'function') {
      if (!channel) {
        channel = new MessageChannel(); channel.port1.onmessage = () => turns.shift()?.();
        channel.port1.unref?.(); channel.port2.unref?.();
      }
      return new Promise(resolve => { turns.push(resolve); channel.port2.postMessage(null); });
    }
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  const supported = () => typeof indexedDB !== 'undefined' && typeof IDBKeyRange !== 'undefined';
  const request = value => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || Error('localIndexUnavailable'));
  });
  function database() {
    if (!supported()) return Promise.reject(Error('localIndexUnavailable'));
    if (!opening) opening = new Promise((resolve, reject) => {
      const pending = indexedDB.open(DB, SCHEMA);
      pending.onupgradeneeded = () => {
        const db = pending.result;
        // Every store is disposable. A schema change invalidates both indexes
        // together; the original Chrome storage/native tree is untouched.
        for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        // Separate metadata stores: a Quick publish never waits on bookmark
        // readers and the reverse. Every data key begins with its generation.
        db.createObjectStore('searchMeta', { keyPath: 'key' });
        db.createObjectStore('bookmarkMeta', { keyPath: 'key' });
        const records = db.createObjectStore('records', { keyPath: ['gen', 'kind', 'position'] });
        records.createIndex('id', ['gen', 'kind', 'entry.id'], { unique: true });
        db.createObjectStore('postings', { keyPath: ['gen', 'key'] });
        db.createObjectStore('searchQueries', { keyPath: ['gen', 'kind', 'block'] });
        db.createObjectStore('bookmarkTerms', { keyPath: ['gen', 'key'] });
        db.createObjectStore('bookmarkQueries', { keyPath: ['gen', 'key'] });
        // Small additive postings written by preview patches; a new generation
        // starts without them. Stale main postings are harmless: text is re-verified.
        db.createObjectStore('bookmarkTermExtras', { keyPath: ['gen', 'key'] });
        const nodes = db.createObjectStore('bookmarkNodes', { keyPath: ['gen', 'id'] });
        nodes.createIndex('kind', ['gen', 'kind']);
        nodes.createIndex('position', ['gen', 'position'], { unique: true });
        nodes.createIndex('url', ['gen', 'urlKey']);
        nodes.createIndex('parent', ['gen', 'kind', 'parentId', 'position']);
        nodes.createIndex('recent', ['gen', 'kind', 'recent', 'position']);
      };
      pending.onsuccess = () => {
        const db = pending.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      pending.onerror = () => { opening = null; reject(pending.error || Error('localIndexUnavailable')); };
      pending.onblocked = () => { opening = null; reject(Error('localIndexUnavailable')); };
    });
    return opening;
  }
  async function transaction(stores, mode, work) {
    const db = await database(), tx = db.transaction(stores, mode);
    const complete = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || Error('localIndexUnavailable'));
    });
    // Attach a handler before any awaited request can fail/abort the transaction.
    complete.catch(() => {});
    let value;
    // A failed write must not commit the requests issued before the failure.
    try { value = await work(tx); }
    catch (error) { try { tx.abort(); } catch {} throw error; }
    await complete;
    return value;
  }
  const range = (gen, kind) => IDBKeyRange.bound([gen, kind, 0], [gen, kind, MAX]);
  const parentRange = (gen, kind, id) => IDBKeyRange.bound([gen, kind, id, 0], [gen, kind, id, MAX]);
  const time = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const published = meta => meta?.schema === SCHEMA && Number.isInteger(meta.generation) && meta.generation > 0;
  const textSize = value => typeof value === 'string' ? value.length * 2
    : Array.isArray(value) ? value.reduce((sum, part) => sum + textSize(part), 16) : 8;

  // Per-context write queues and supersession counters; cross-context order is
  // decided by the claim recorded in the metadata store.
  const tails = { search: Promise.resolve(), bookmarks: Promise.resolve() }, generations = { search: 0, bookmarks: 0 };
  function serial(key, work) {
    const run = tails[key].then(work, work);
    tails[key] = run.catch(() => {});
    return run;
  }
  const readMeta = (tx, key) => request(tx.objectStore(META[key]).get(key));
  async function meta(key) {
    if (!supported()) return null;
    return transaction([META[key]], 'readonly', tx => readMeta(tx, key));
  }
  // Claims a new generation. `stale(current, pending)` decides whether a newer
  // published snapshot or a live, newer claim makes this build pointless.
  async function claim(key, fields, stale) {
    return transaction([META[key]], 'readwrite', async tx => {
      const store = tx.objectStore(META[key]);
      const current = await readMeta(tx, key);
      const base = current?.schema === SCHEMA ? current : { key, schema: SCHEMA, ready: false, generation: 0, nextGeneration: 1, pending: null };
      const pending = base.pending && Date.now() - time(base.pending.startedAt) < LEASE ? base.pending : null;
      if (stale(base, pending)) return { stale: base };
      const gen = Math.max(1, time(base.nextGeneration));
      store.put({ ...base, nextGeneration: gen + 1, pending: { generation: gen, startedAt: Date.now(), ...fields } });
      return { gen };
    });
  }
  async function release(key, gen) {
    try {
      await transaction([META[key]], 'readwrite', async tx => {
        const current = await readMeta(tx, key);
        if (current?.pending?.generation === gen) tx.objectStore(META[key]).put({ ...current, pending: null });
      });
    } catch {}
  }
  // Writes rows in short single-store transactions. `check` runs before each
  // chunk and stops a superseded build; it does not yield again, because
  // awaiting each transaction's completion already lets other tasks and
  // extension messages run between chunks.
  async function writeChunks(storeName, rows, check, size) {
    for (let start = 0; start < rows.length; ) {
      await check();
      let end = start, bytes = 0;
      while (end < rows.length && end - start < CHUNK_ROWS) {
        const next = size(rows[end]);
        if (end > start && bytes + next > CHUNK_BYTES) break;
        bytes += next; end++;
      }
      await transaction([storeName], 'readwrite', tx => {
        const store = tx.objectStore(storeName);
        for (let i = start; i < end; i++) store.put(rows[i]);
      });
      start = end;
    }
  }
  // Removes every generation below nextGeneration that is neither published
  // nor claimed. Such a generation can never become active again, so the
  // ranges computed from one metadata read stay safe while other writers run.
  let sweeping = Promise.resolve();
  function sweep(key) {
    sweeping = sweeping.then(() => whileActive(async () => {
      const current = await meta(key);
      if (current?.schema !== SCHEMA) return;
      const limit = time(current.nextGeneration);
      const keep = [...new Set([current.generation, current.pending?.generation])].filter(gen => Number.isInteger(gen) && gen > 0 && gen < limit).sort((a, b) => a - b);
      const ranges = [];
      let low = null;
      for (const high of [...keep, limit]) {
        if (high < 1 || low !== null && high <= low) continue;
        ranges.push(low === null ? IDBKeyRange.upperBound([high], true) : IDBKeyRange.bound([low, []], [high], true, true));
        low = high;
      }
      for (const storeName of DATA[key]) for (const keys of ranges) {
        for (;;) {
          const removed = await transaction([storeName], 'readwrite', async tx => {
            const store = tx.objectStore(storeName), found = await request(store.getAllKeys(keys, SWEEP_KEYS));
            if (found.length) store.delete(IDBKeyRange.bound(found[0], found[found.length - 1]));
            return found.length;
          });
          if (removed < SWEEP_KEYS) break;
          await yieldTask();
        }
      }
    })).catch(() => {});
    return sweeping;
  }
  const idle = () => sweeping;
  const union = (a, b) => [...new Set([...a, ...b])].sort((x, y) => x - y);
  function intersection(a, b) {
    const found = []; let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { found.push(a[i]); i++; j++; }
      else if (a[i] < b[j]) i++; else j++;
    }
    return found;
  }
  function grams(value, length) {
    const result = new Set();
    for (let i = 0; i <= value.length - length; i++) result.add(value.slice(i, i + length));
    return result;
  }
  function indexTerms(values) {
    const keys = new Set();
    for (const value of [values.title, ...values.aliases, values.source, values.url, ...values.locations, values.inbox]) {
      for (const letter of grams(value, 1)) keys.add(`c:${letter}`);
      for (const gram of grams(value, 3)) keys.add(`g:${gram}`);
    }
    // A fuzzy match must contain every query character in a title or alias.
    // These postings are only a conservative candidate filter: the original
    // subsequence/ranking rules still decide whether each candidate matches.
    for (const value of [values.title, ...values.aliases]) {
      for (const letter of grams(value, 1)) if (/[a-z0-9]/.test(letter)) keys.add(`f:${letter}`);
    }
    return keys;
  }
  function bookmarkAllowed(meta, context) {
    const config = context?.bookmarkConfig || {};
    return context?.bookmarkPermission === true && config.enabled === true && meta?.bookmarkEnabled === true
      && !meta.bookmarkError && (config.scopeId || null) === (meta.bookmarkScope || null);
  }
  async function putSearchSource(source, revision = Date.now(), isCurrent = () => true) {
    if (!supported() || !globalThis.LaterOnQuickSearch) return false;
    return whileActive(() => buildSearchSource(source, revision, isCurrent));
  }
  async function buildSearchSource(source, revision, isCurrent) {
    const search = globalThis.LaterOnQuickSearch;
    const input = { items: source.laterOnItems, projects: source.laterOnProjects,
      bookmarks: source.laterOnBookmarkSearchState || source.laterOnBookmarkState,
      bookmarkConfig: source.laterOnBookmarkConfig };
    const generation = ++generations.search;
    const live = () => generation === generations.search && isCurrent();
    const pause = async () => {
      if (!live()) throw Error('staleLocalIndex');
      await yieldTask();
    };
    const reading = await search.buildAsync({ items: input.items, projects: input.projects }, pause);
    const all = await search.buildAsync(input, pause);
    const rows = [], postings = new Map(), queryBlocks = [];
    // Lists that grow past the dense threshold are dropped and recorded; a
    // query treats such a term as "every row" (no filtering), so matches are
    // never lost, only verified by the column scan instead.
    const omitted = new Set(), stats = {};
    let work = 0;
    for (const [kind, entries] of [['r', reading], ['a', all]]) {
      const normalized = search.preparedFields(entries);
      const limit = Math.max(DENSE_POSTING_MIN, Math.ceil(entries.length / DENSE_POSTING_SHARE));
      const counts = stats[kind] = { rows: entries.length, limit, keys: 0, positions: 0, omittedKeys: 0, omittedPositions: 0 };
      let block, aliases, locations;
      for (const [position, entry] of entries.entries()) {
        if (++work % 250 === 0) await pause();
        const values = normalized[position];
        rows.push({ kind, position, entry, values });
        if (position % QUERY_BLOCK_SIZE === 0) {
          block = { kind, block: Math.floor(position / QUERY_BLOCK_SIZE), start: position,
            savedAt: [], title: [], aliases: [], source: [], url: [], locations: [], inbox: [] };
          queryBlocks.push(block); aliases = new Map(); locations = new Map();
        }
        // Columns avoid cloning every complete entry for broad queries. Reuse
        // identical small arrays within a block (especially folder paths and
        // empty aliases), so IndexedDB can clone those references only once.
        const aliasKey = JSON.stringify(values.aliases), locationKey = JSON.stringify(values.locations);
        if (!aliases.has(aliasKey)) aliases.set(aliasKey, values.aliases);
        if (!locations.has(locationKey)) locations.set(locationKey, values.locations);
        block.savedAt.push(entry.savedAt); block.title.push(values.title);
        block.aliases.push(aliases.get(aliasKey)); block.source.push(values.source);
        block.url.push(values.url); block.locations.push(locations.get(locationKey)); block.inbox.push(values.inbox);
        for (const term of indexTerms(values)) {
          const key = `${kind}:${term}`;
          if (omitted.has(key)) { counts.omittedPositions++; continue; }
          let list = postings.get(key);
          if (!list) postings.set(key, list = []);
          list.push(position);
          if (list.length > limit) {
            postings.delete(key); omitted.add(key);
            counts.omittedKeys++; counts.omittedPositions += list.length;
          }
        }
      }
    }
    for (const [key, list] of postings) { const counts = stats[key[0]]; counts.keys++; counts.positions += list.length; }
    // Source views for mode searches. Each combined row records its library
    // membership (bit 1 Reading, bit 2 Bookmarks). A URL in both libraries
    // also gets a bookmark-only row ('b', at its combined position) built from
    // bookmark data alone, so a Bookmarks search never matches, ranks or shows
    // Reading titles, projects or inbox state. Pages only in Bookmarks already
    // equal their bookmark-only form. Combined postings contain every
    // bookmark-only term, so they stay a valid candidate filter.
    const mask = new Uint8Array(all.length), shared = new Map(), sharedDates = new Map();
    let bookmarkTotal = 0;
    for (const [position, entry] of all.entries()) {
      if (++work % 1000 === 0) await pause();
      const bits = (entry.readingIds?.length ? 1 : 0) | (entry.bookmarkIds?.length ? 2 : 0);
      mask[position] = bits;
      if (bits & 2) bookmarkTotal++;
      if (bits === 3) shared.set(entry.url, position);
    }
    if (shared.size) {
      const href = value => { try { return new URL(value).href; } catch { return ''; } };
      const nodes = (Array.isArray(input.bookmarks?.nodes) ? input.bookmarks.nodes : []).filter(node => node && (!node.url || shared.has(href(node.url))));
      const bookmarkOnly = await search.buildAsync({ bookmarks: { ...input.bookmarks, nodes }, bookmarkConfig: input.bookmarkConfig }, pause);
      const normalized = search.preparedFields(bookmarkOnly), views = [];
      for (const [index, entry] of bookmarkOnly.entries()) {
        const position = shared.get(entry.url);
        if (position !== undefined) {
          views.push({ kind: 'b', position, entry, values: normalized[index] });
          sharedDates.set(position, entry.savedAt);
        }
      }
      views.sort((a, b) => a.position - b.position);
      let block = null;
      for (const view of views) {
        if (++work % 250 === 0) await pause();
        rows.push(view);
        const key = Math.floor(view.position / QUERY_BLOCK_SIZE);
        if (block?.block !== key) {
          block = { kind: 'b', block: key, start: key * QUERY_BLOCK_SIZE, positions: [],
            savedAt: [], title: [], aliases: [], source: [], url: [], locations: [], inbox: [] };
          queryBlocks.push(block);
        }
        const values = view.values;
        block.positions.push(view.position); block.savedAt.push(view.entry.savedAt); block.title.push(values.title);
        block.aliases.push(values.aliases); block.source.push(values.source); block.url.push(values.url);
        block.locations.push(values.locations); block.inbox.push(values.inbox);
      }
    }
    // Bookmarks use their own recent order, including URL order when native
    // timestamps tie. Combined positions can be ordered by Reading savedAt,
    // so keep the ranking position separate from the row used for hydration.
    const bookmarkOrder = [];
    for (let position = 0; position < all.length; position++) {
      if (++work % 1000 === 0) await pause();
      if (mask[position] & 2) bookmarkOrder.push(position);
    }
    bookmarkOrder.sort((a, b) => (sharedDates.get(b) ?? all[b].savedAt) - (sharedDates.get(a) ?? all[a].savedAt)
      || all[a].url.localeCompare(all[b].url));
    const bookmarkRank = new Uint32Array(all.length);
    bookmarkOrder.forEach((position, rank) => { bookmarkRank[position] = rank; });
    const fields = { counts: { r: reading.length, a: all.length }, readingItems: Array.isArray(input.items) ? input.items.length : 0,
      bookmarkPages: (input.bookmarks?.nodes || []).filter(node => node?.url).length,
      bookmarkEnabled: input.bookmarkConfig?.enabled === true && input.bookmarks?.enabled === true,
      bookmarkScope: input.bookmarks?.scopeId || null, bookmarkError: input.bookmarks?.error || null,
      thinBookmarks: !!source.laterOnBookmarkSearchState,
      // Every fresh snapshot carries the list (possibly empty); older
      // snapshots without it have every posting stored.
      omittedPostings: [...omitted], postingStats: stats,
      // Published together with the `searchSources` record below; snapshots
      // without it cannot answer a Bookmarks-only mode.
      sourceViews: true, sharedPages: shared.size };
    if (!live()) throw Error('staleLocalIndex');
    return serial('search', async () => {
      if (!live()) throw Error('staleLocalIndex');
      // Revisions are monotonic per source change. A ready snapshot with a
      // higher revision, or a live claim for one, means this source is older.
      // Only an explicitly invalidated snapshot (markDirty) accepts any build.
      const newer = (current, pending) => published(current) && current.ready === true && time(current.revision) > time(revision)
        || !!pending && time(pending.revision) > time(revision);
      const claimed = await claim('search', { revision }, newer);
      if (claimed.stale) throw Error('staleLocalIndex');
      const gen = claimed.gen;
      sweep('search');
      let checks = 0;
      const check = async () => {
        if (!live()) throw Error('staleLocalIndex');
        // Another context may have claimed a newer build meanwhile.
        if (++checks % 4 === 0 && (await meta('search'))?.pending?.generation !== gen) throw Error('staleLocalIndex');
      };
      try {
        for (const row of rows) row.gen = gen;
        for (const block of queryBlocks) block.gen = gen;
        await writeChunks('records', rows, check, row => textSize(row.values.title) + textSize(row.values.url) * 2 + textSize(row.values.aliases)
          + textSize(row.values.locations) + textSize(row.entry.title) + 400);
        await writeChunks('postings', [...postings].map(([key, positions]) => ({ gen, key, positions: new Uint32Array(positions) })), check,
          row => row.positions.length * 4 + row.key.length * 2 + 64);
        await writeChunks('searchQueries', queryBlocks, check, block => textSize(block.title) + textSize(block.url) + textSize(block.aliases)
          + textSize(block.locations) + textSize(block.source) + 4096);
        const publishedMeta = await transaction(['searchMeta'], 'readwrite', async tx => {
          const current = await readMeta(tx, 'search');
          if (current?.pending?.generation !== gen || !live() || newer(current, null)) throw Error('staleLocalIndex');
          const next = { ...current, ...fields, key: 'search', schema: SCHEMA, ready: true, generation: gen, pending: null,
            revision: time(revision), updatedAt: Date.now() };
          tx.objectStore('searchMeta').put(next);
          // One small record, replaced in the same transaction as the
          // metadata, so readers never pair one generation's rows with
          // another generation's membership.
          tx.objectStore('searchMeta').put({ key: 'searchSources', generation: gen, mask, bookmarkTotal,
            bookmarkRank, bookmarkOrder: new Uint32Array(bookmarkOrder) });
          return next;
        });
        sweep('search');
        return publishedMeta;
      } catch (error) {
        await release('search', gen); sweep('search');
        throw error;
      }
    });
  }
  async function info(key = 'search') {
    if (!supported() || !META[key]) return null;
    return meta(key);
  }
  // Explicit invalidation: readers return null until the next publish.
  async function markDirty(key = 'search') {
    if (!supported() || !META[key]) return;
    await transaction([META[key]], 'readwrite', async tx => {
      const current = await readMeta(tx, key);
      if (current) tx.objectStore(META[key]).put({ ...current, ready: false });
    });
  }
  // Library selection for a mode search. Without `context.sources` the
  // original behavior holds: combined rows when bookmarks are allowed.
  function selection(meta, context) {
    const sources = Array.isArray(context?.sources) ? context.sources : null;
    const books = bookmarkAllowed(meta, context) && (!sources || sources.includes('bookmarks'));
    const reading = !sources || sources.includes('reading');
    return { sources, reading, books, bookOnly: !!sources && books && !reading, none: !!sources && !books && !reading,
      kind: books ? 'a' : 'r' };
  }
  // Bookmark-only membership and views of the published generation, or null
  // for an older snapshot without them.
  async function sourceViews(tx, meta) {
    const views = await request(tx.objectStore('searchMeta').get('searchSources'));
    return views?.generation === meta.generation && views.mask?.length === meta.counts?.a
      && views.bookmarkRank?.length === views.mask.length && views.bookmarkOrder?.length === views.bookmarkTotal ? views : null;
  }
  async function search(query, context, { limit = 50 } = {}) {
    if (!supported() || !globalThis.LaterOnQuickSearch) return null;
    const current = () => typeof context?.isCurrent !== 'function' || context.isCurrent();
    const check = () => { if (!current()) throw Error('cancelledLocalIndex'); };
    if (!current()) return null;
    try { return await transaction(['searchMeta', 'records', 'postings', 'searchQueries'], 'readonly', async tx => {
      const meta = await readMeta(tx, 'search');
      check();
      if (!meta?.ready || !published(meta)) return null;
      const pick = selection(meta, context), gen = meta.generation, kind = pick.kind;
      const views = pick.bookOnly ? await sourceViews(tx, meta) : null;
      check();
      if (pick.bookOnly && !views) return null;
      const count = pick.bookOnly ? views.bookmarkTotal : meta.counts[kind];
      const engine = globalThis.LaterOnQuickSearch, phrase = engine.fold(engine.text(query, 512));
      const maximum = Math.max(0, Math.min(100, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 50));
      const records = tx.objectStore('records'), terms = tx.objectStore('postings'), queries = tx.objectStore('searchQueries');
      // `bookmarkVariant` states whether this answer came from the combined
      // Reading + Bookmarks rows; false means Reading rows only.
      // `sourcesFiltered` states that matching, ranking, totals and every
      // returned field use only the selected libraries.
      const facts = { persistent: true, revision: meta.revision, bookmarkVariant: kind === 'a',
        ...(pick.sources ? { sourcesFiltered: true, generation: gen } : {}),
        ...(meta.pending && time(meta.pending.revision) > time(meta.revision) ? { pending: true } : {}) };
      // Bookmarks-only: pages in both libraries use their bookmark-only row.
      const member = position => !views || (views.mask[position] & 2) !== 0;
      const rowKind = position => views && views.mask[position] === 3 ? 'b' : kind;
      const hydrate = position => request(records.get([gen, rowKind(position), position]));
      const forRanking = row => views ? { ...row, position: views.bookmarkRank[row.position] } : row;
      const lookup = async () => {
        check();
        const urls = [...new Set(Array.isArray(context?.lookupUrls) ? context.lookupUrls.filter(url => typeof url === 'string') : [])];
        if (!pick.sources || pick.none || !urls.length) return {};
        const ids = records.index('id'), found = [];
        for (let start = 0; start < urls.length; start += QUERY_BLOCK_SIZE) {
          check();
          // All batches stay in this one readonly snapshot. Await the issued
          // requests before cancellation; never present a partial lookup as a
          // proof that omitted URLs have no library membership.
          const batch = await Promise.allSettled(urls.slice(start, start + QUERY_BLOCK_SIZE).map(async url => {
            let row = await request(ids.get([gen, kind, `page:${url}`]));
            check();
            if (row && views) row = !member(row.position) ? null : rowKind(row.position) === 'b' ? await hydrate(row.position) : row;
            check();
            if (!row) return;
            const match = engine.searchRecords([row], query, { limit: 1 }).results[0];
            found.push({ url, entry: row.entry, values: row.values, libraryScore: match ? match.score : null });
          }));
          check();
          const failure = batch.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
        }
        const order = new Map(urls.map((url, index) => [url, index]));
        return { lookupEntries: found.sort((a, b) => order.get(a.url) - order.get(b.url)) };
      };
      const answer = async () => {
        check();
        if (pick.none) return { results: [], total: 0 };
        if (!phrase) {
          if (!views) {
            const rows = maximum ? await request(records.getAll(range(gen, kind), maximum)) : [];
            check();
            return { results: rows.map(row => ({ ...row.entry, score: 0 })), total: count };
          }
          const rows = (await Promise.all(Array.from(views.bookmarkOrder.slice(0, maximum), hydrate))).filter(Boolean);
          check();
          return { results: rows.map(row => ({ ...row.entry, score: 0 })), total: count };
        }
        // Terms whose lists were too dense to store impose no filter (`ALL`);
        // the exact verification below decides every match. Older snapshots
        // have no such list and store every posting.
        const ALL = null, omitted = new Set(Array.isArray(meta.omittedPostings) ? meta.omittedPostings : []);
        const cache = new Map();
        function posting(term) {
          const key = `${kind}:${term}`;
          if (!cache.has(key)) cache.set(key, request(terms.get([gen, key])).then(row => row?.positions || []));
          return cache.get(key);
        }
        async function intersectTerms(keys) {
          const stored = [...keys].filter(term => !omitted.has(`${kind}:${term}`));
          if (!stored.length) return ALL;
          const lists = await Promise.all(stored.map(posting));
          check();
          lists.sort((a, b) => a.length - b.length);
          let result = lists[0] || [];
          for (let i = 1; i < lists.length && result.length; i++) result = intersection(result, lists[i]);
          return result;
        }
        let candidates = ALL;
        for (const term of new Set(phrase.split(/\s+/).filter(Boolean))) {
          // Two separated trigrams bound I/O even for a very long pasted URL.
          // Verification below checks the complete term, including punctuation.
          const literal = term.length >= 3 ? new Set([`g:${term.slice(0, 3)}`, `g:${term.slice(-3)}`])
            : new Set([...grams(term, 1)].map(letter => `c:${letter}`));
          let ids = await intersectTerms(literal);
          if (ids !== ALL && /^[a-z0-9]{3,32}$/.test(term)) {
            const fuzzy = await intersectTerms(new Set([...term].map(letter => `f:${letter}`)));
            ids = fuzzy === ALL ? ALL : union(ids, fuzzy);
          }
          if (ids !== ALL) candidates = candidates === ALL ? ids : intersection(candidates, ids);
          if (candidates !== ALL && !candidates.length) break;
        }
        if (candidates !== ALL && views) candidates = candidates.filter(member);
        if (candidates === ALL ? !count : !candidates.length) return { results: [], total: 0 };
        if (candidates !== ALL && candidates.length <= 2 * maximum) {
          const rows = (await Promise.all(Array.from(candidates, hydrate))).filter(Boolean);
          check();
          return engine.searchRecords(rows.map(forRanking), query, { limit: maximum });
        }
        // More candidates than a page: rank from the light column blocks that
        // contain them (all blocks when dense or unfiltered), then hydrate only
        // the winners.
        const dense = candidates === ALL || candidates.length > count / 5;
        const keys = dense ? null : [...new Set(Array.from(candidates, position => Math.floor(position / QUERY_BLOCK_SIZE)))];
        const blocks = dense ? await request(queries.getAll(range(gen, kind)))
          : (await Promise.all(keys.map(block => request(queries.get([gen, kind, block]))))).filter(Boolean);
        check();
        const shared = new Map();
        if (views) {
          const own = dense ? await request(queries.getAll(range(gen, 'b')))
            : (await Promise.all(keys.map(block => request(queries.get([gen, 'b', block]))))).filter(Boolean);
          check();
          for (const block of own) block.positions.forEach((position, i) => shared.set(position, [block, i]));
        }
        const allowed = dense ? null : new Set(candidates);
        function* queryRows() {
          for (const block of blocks) for (let i = 0; i < block.savedAt.length; i++) {
            if (i % QUERY_BLOCK_SIZE === 0) check();
            const position = block.start + i;
            if (allowed ? !allowed.has(position) : !member(position)) continue;
            const [source, at] = shared.get(position) || [block, i];
            yield { position: views ? views.bookmarkRank[position] : position, entry: { position, savedAt: source.savedAt[at] }, values: {
              title: source.title[at], aliases: source.aliases[at], source: source.source[at], url: source.url[at],
              locations: source.locations[at], inbox: source.inbox[at]
            } };
          }
        }
        const ranked = engine.searchRecords(queryRows(), query, { limit: maximum });
        check();
        const winners = await Promise.all(ranked.results.map(hit => hydrate(hit.position)));
        check();
        return { results: winners.map((row, i) => row && { ...row.entry, score: ranked.results[i].score }).filter(Boolean),
          total: ranked.total };
      };
      const complete = await Promise.allSettled([answer(), lookup()]);
      check();
      const failure = complete.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return { ...complete[0].value, ...facts, ...complete[1].value };
    }); } catch (error) {
      if (error?.message === 'cancelledLocalIndex') return null;
      throw error;
    }
  }
  // One result for opening, with the same source selection as search.
  async function getEntry(id, context) {
    if (!supported()) return null;
    return transaction(['searchMeta', 'records'], 'readonly', async tx => {
      const meta = await readMeta(tx, 'search');
      if (!meta?.ready || !published(meta)) return null;
      const pick = selection(meta, context);
      if (pick.none) return null;
      const records = tx.objectStore('records');
      let row = await request(records.index('id').get([meta.generation, pick.kind, id]));
      if (row && pick.bookOnly) {
        const views = await sourceViews(tx, meta), bits = views?.mask[row.position] || 0;
        row = !(bits & 2) ? null : bits === 3 ? await request(records.get([meta.generation, 'b', row.position])) : row;
      }
      return row?.entry || null;
    });
  }
  const LOCAL_IMAGE = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i;
  const hasImage = node => typeof node?.preview?.image === 'string' && LOCAL_IMAGE.test(node.preview.image);
  // Membership identity: the parsed href keeps query and fragment. Native URLs
  // are stored unchanged; only this lookup key is normalized.
  function urlKey(value) {
    try { return new URL(value).href; } catch { return String(value || ''); }
  }
  function mergeSorted(a, b) {
    if (!b?.length) return a || [];
    if (!a?.length) return Array.from(b);
    const result = []; let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      const next = j >= b.length || i < a.length && a[i] <= b[j] ? a[i++] : b[j++];
      if (result[result.length - 1] !== next) result.push(next);
    }
    return result;
  }
  // Folder mosaics: covers first, then plain pages, each in native position
  // order (a stable "covers first" sort of every descendant, truncated to 3).
  function topPreviews(sequence) {
    const images = [], plain = [];
    for (const entry of sequence) {
      if (entry.image) { if (images.length < 3) images.push(entry); }
      else if (plain.length < 3) plain.push(entry);
    }
    const top = images.concat(plain).slice(0, 3);
    return { previewIds: top.map(entry => entry.id), previewImages: top.map(entry => !!entry.image) };
  }
  const sameTop = (a, b) => JSON.stringify([a?.previewIds || [], a?.previewImages || []]) === JSON.stringify([b?.previewIds || [], b?.previewImages || []]);
  const textGrams = value => [...grams(value, 1)].map(letter => `c:${letter}`).concat([...grams(value, 3)].map(gram => `g:${gram}`));


  const LEAN_PAGE_FIELDS = ['title', 'url', 'path', 'dateAdded', 'protected', 'writable'];
  // Source blocks share bookmarkTermExtras with additive c:/g: postings; the
  // zero-padded key keeps lexical order equal to native position order.
  const SOURCE_PREFIX = 'source:';
  const sourceKey = block => SOURCE_PREFIX + String(block).padStart(10, '0');
  const LEAN_FOLDER_FIELDS = ['id', 'parentId', 'title', 'path', 'dateAdded', 'protected', 'writable', 'folderType'];
  // The published bookmark snapshot as a lean source (no covers, summaries or
  // descriptions), read one query block per short transaction. Returns null
  // when no complete source exists, it is older than `updatedAt`, the caller
  // cancels, or a newer generation was published during the read.
  async function bookmarkSearchSource({ updatedAt = 0, isCurrent } = {}) {
    if (!supported()) return null;
    return whileActive(() => readBookmarkSource(updatedAt, isCurrent));
  }
  async function readBookmarkSource(updatedAt, isCurrent) {
    const current = () => typeof isCurrent !== 'function' || isCurrent();
    const start = await meta('bookmarks');
    if (!published(start) || !start.ready || start.searchSourceReady !== true || time(start.updatedAt) < time(updatedAt)) return null;
    const gen = start.generation;
    if (!current()) return null;
    const folderRows = await transaction(['bookmarkNodes'], 'readonly', tx => request(tx.objectStore('bookmarkNodes').index('kind').getAll([gen, 'folder'])));
    const folders = folderRows.map(row => {
      const node = {};
      for (const field of LEAN_FOLDER_FIELDS) if (row[field] !== undefined) node[field] = row[field];
      return node;
    });
    const byId = new Map(folders.map(node => [node.id, node])), scoped = new Map();
    const inScope = node => {
      if (!start.scopeId) return true;
      const chain = [];
      let result = false;
      for (let item = node, seen = new Set(); item && !seen.has(item.id); item = byId.get(item.parentId)) {
        if (item.id === start.scopeId) { result = true; break; }
        if (scoped.has(item.id)) { result = scoped.get(item.id); break; }
        seen.add(item.id); chain.push(item.id);
      }
      for (const id of chain) scoped.set(id, result);
      return result;
    };
    const pages = [];
    for (let after = null; ; ) {
      await yieldTask();
      if (!current()) return null;
      const keys = after === null ? IDBKeyRange.bound([gen, SOURCE_PREFIX], [gen, SOURCE_PREFIX + '\uffff'])
        : IDBKeyRange.bound([gen, after], [gen, SOURCE_PREFIX + '\uffff'], true);
      const [block] = await transaction(['bookmarkTermExtras'], 'readonly', tx =>
        request(tx.objectStore('bookmarkTermExtras').getAll(keys, 1)));
      if (!block) break;
      for (const row of block.rows) {
        const node = { id: row.id, parentId: row.parentId };
        for (const field of LEAN_PAGE_FIELDS) if (row[field] !== undefined) node[field] = row[field];
        if (typeof node.url !== 'string') return null;
        pages.push(node);
      }
      after = block.key;
    }
    if (!current()) return null;
    // Rows of a published generation are never swept, so an unchanged
    // generation at the end proves every block came from one snapshot.
    const end = await meta('bookmarks');
    if (!published(end) || end.generation !== gen || end.searchSourceReady !== true) return null;
    return { enabled: start.enabled === true, scopeId: start.scopeId || null, error: start.error || null,
      updatedAt: time(end.updatedAt), generation: gen,
      folders, nodes: [...folders.filter(node => inScope(node)), ...pages] };
  }

  async function putBookmarkState(state, options = {}) {
    if (!supported()) return false;
    return whileActive(() => buildBookmarkState(state, options));
  }
  async function buildBookmarkState(state, options) {
    const generation = ++generations.bookmarks;
    const live = () => generation === generations.bookmarks && (typeof options.isCurrent !== 'function' || options.isCurrent());
    const pause = async () => { if (!live()) throw Error('staleLocalIndex'); await yieldTask(); };
    const incomingAt = time(state.updatedAt) || Date.now(), signature = state.signature ?? options.signature ?? null;
    // The previous ready snapshot keeps serving while this one is prepared.
    const nodes = new Map();
    for (const node of [...state.folders || [], ...state.nodes || []]) if (node?.id) nodes.set(node.id, node);
    const rows = [], children = new Map(), summaries = new Map();
    const scopeCache = new Map();
    function inScope(node) {
      if (!state.scopeId) return true;
      if (scopeCache.has(node.id)) return scopeCache.get(node.id);
      const seen = new Set(), chain = [];
      let result = false;
      for (let current = node; current && !seen.has(current.id); current = nodes.get(current.parentId)) {
        if (current.id === state.scopeId) { result = true; break; }
        if (scopeCache.has(current.id)) { result = scopeCache.get(current.id); break; }
        seen.add(current.id); chain.push(current.id);
      }
      for (const id of chain) scopeCache.set(id, result);
      return result;
    }
    const paths = new Map();
    function folderPath(id) {
      if (paths.has(id)) return paths.get(id);
      const parts = [], seen = new Set();
      for (let node = nodes.get(id); node && !seen.has(node.id); node = nodes.get(node.parentId)) {
        seen.add(node.id);
        if (node.title) parts.unshift(node.title);
        if (node.id === state.scopeId) break;
      }
      const path = parts.join(' / '); paths.set(id, path); return path;
    }
    let position = 0, work = 0;
    for (const node of nodes.values()) {
      if (++work % 250 === 0) await pause();
      if (node.url && !inScope(node)) continue;
      const row = { ...node, kind: node.url ? 'page' : 'folder', recent: -Math.max(0, Number(node.dateAdded) || 0),
        parentId: node.parentId || '', position: position++ };
      if (node.url) row.urlKey = urlKey(node.url);
      row.searchText = `${node.title || ''} ${globalThis.LaterOnUrl?.searchTitle?.(node.url) || ''} ${node.url || ''} ${folderPath(node.url ? node.parentId : node.id)} ${node.preview?.description || ''}`.toLocaleLowerCase();
      rows.push(row);
      if (!children.has(row.parentId)) children.set(row.parentId, []);
      children.get(row.parentId).push(row);
    }
    function summary(id, seen = new Set()) {
      if (summaries.has(id)) return summaries.get(id);
      if (seen.has(id)) return { pages: 0, folders: 0, previewIds: [], previewImages: [] };
      seen.add(id);
      let pages = 0, folders = 0;
      const sequence = [];
      for (const node of children.get(id) || []) {
        if (node.url) { pages++; sequence.push({ id: node.id, image: hasImage(node) }); }
        else {
          const nested = summary(node.id, seen); pages += nested.pages; folders += nested.folders + 1;
          nested.previewIds.forEach((child, index) => sequence.push({ id: child, image: nested.previewImages[index] }));
        }
      }
      const result = { pages, folders, ...topPreviews(sequence) };
      seen.delete(id); summaries.set(id, result); return result;
    }
    for (const row of rows) if (!row.url) {
      row.summary = summary(row.id);
      // Direct cover pages in native order: lets a preview patch re-select a
      // folder's top three from a bounded read instead of scanning descendants.
      row.directImages = (children.get(row.id) || []).filter(node => node.url && hasImage(node)).map(node => [node.id, node.position]);
    }
    const postings = new Map(), queryBlocks = new Map(), sourceBlocks = new Map();
    for (const row of rows) {
      if (++work % 250 === 0) await pause();
      if (!row.url) continue;
      const block = Math.floor(row.position / QUERY_BLOCK_SIZE);
      if (!queryBlocks.has(block)) queryBlocks.set(block, { key: block, rows: [] });
      // Dense searches scan only prepared text and identities. Covers and
      // descriptions in the full node are fetched for the visible slice only.
      queryBlocks.get(block).rows.push({ id: row.id, parentId: row.parentId, position: row.position, searchText: row.searchText });
      // Lean source fields in separate blocks: Quick Switcher rebuilds from
      // them instead of the large Chrome storage mirror, while dense queries
      // keep cloning only the prepared text above.
      if (!sourceBlocks.has(block)) sourceBlocks.set(block, { key: sourceKey(block), rows: [] });
      const entry = { id: row.id, parentId: row.parentId };
      for (const field of LEAN_PAGE_FIELDS) if (row[field] !== undefined) entry[field] = row[field];
      sourceBlocks.get(block).rows.push(entry);
      for (const key of textGrams(row.searchText)) {
        if (!postings.has(key)) postings.set(key, []);
        postings.get(key).push(row.position);
      }
    }
    if (!live()) throw Error('staleLocalIndex');
    const fields = { enabled: state.enabled === true, scopeId: state.scopeId || null,
      error: state.error || (state.scopeId && !nodes.has(state.scopeId) ? 'bookmarkScopeMissing' : null),
      updatedAt: incomingAt, signature, totalPages: rows.filter(row => row.url).length, searchSourceReady: true };
    // A newer native state, published or claimed by a live build, wins.
    const newer = (current, pending) => published(current) && time(current.updatedAt) > incomingAt
      || !!pending && time(pending.updatedAt) > incomingAt;
    return serial('bookmarks', async () => {
      if (!live()) throw Error('staleLocalIndex');
      const claimed = await claim('bookmarks', { updatedAt: incomingAt }, newer);
      if (claimed.stale) return { ...claimed.stale, applied: false, stale: true };
      const gen = claimed.gen;
      sweep('bookmarks');
      let checks = 0;
      const check = async () => {
        if (!live()) throw Error('staleLocalIndex');
        if (++checks % 4 === 0 && (await meta('bookmarks'))?.pending?.generation !== gen) throw Error('staleLocalIndex');
      };
      try {
        for (const row of rows) row.gen = gen;
        for (const block of queryBlocks.values()) block.gen = gen;
        await writeChunks('bookmarkNodes', rows, check, row => textSize(row.searchText) + (typeof row.preview?.image === 'string' ? row.preview.image.length : 0)
          + textSize(row.preview?.description) + 400);
        await writeChunks('bookmarkTerms', [...postings].map(([key, positions]) => ({ gen, key, positions: new Uint32Array(positions) })), check,
          row => row.positions.length * 4 + row.key.length * 2 + 64);
        await writeChunks('bookmarkQueries', [...queryBlocks.values()], check, block => block.rows.reduce((sum, row) => sum + textSize(row.searchText) + 96, 0));
        for (const block of sourceBlocks.values()) block.gen = gen;
        await writeChunks('bookmarkTermExtras', [...sourceBlocks.values()], check, block => block.rows.reduce((sum, row) => sum
          + textSize(row.title) + textSize(row.url) + textSize(row.path) + textSize(row.id) + textSize(row.parentId) + 96, 0));
        const result = await transaction(['bookmarkMeta'], 'readwrite', async tx => {
          const current = await readMeta(tx, 'bookmarks');
          if (current?.pending?.generation !== gen || !live()) throw Error('staleLocalIndex');
          if (newer(current, null)) {
            tx.objectStore('bookmarkMeta').put({ ...current, pending: null });
            return { ...current, pending: null, applied: false, stale: true };
          }
          const next = { ...current, ...fields, key: 'bookmarks', schema: SCHEMA, ready: true, generation: gen, pending: null,
            revision: time(current.revision) + 1 };
          tx.objectStore('bookmarkMeta').put(next);
          return { ...next, applied: true };
        });
        sweep('bookmarks');
        return result;
      } catch (error) {
        await release('bookmarks', gen); sweep('bookmarks');
        throw error;
      }
    });
  }

  // Preview-only change: update the affected pages, their query blocks,
  // additive postings and ancestor folder mosaics in one bounded transaction.
  // Returns false when a full build is required; a stale patch is skipped.
  async function patchBookmarkPreviews({ records = [], removedIds = [] } = {}, patch = {}) {
    if (!supported()) return false;
    const changes = new Map();
    for (const id of Array.isArray(removedIds) ? removedIds : []) if (typeof id === 'string') changes.set(id, null);
    for (const record of Array.isArray(records) ? records : []) if (typeof record?.id === 'string') changes.set(record.id, record);
    const generation = generations.bookmarks;
    return serial('bookmarks', () => transaction(['bookmarkMeta', 'bookmarkNodes', 'bookmarkQueries', 'bookmarkTermExtras'], 'readwrite', async tx => {
      const infoStore = tx.objectStore('bookmarkMeta'), meta = await readMeta(tx, 'bookmarks');
      if (!meta?.ready || !published(meta) || !meta.enabled || meta.error) return false;
      const gen = meta.generation;
      if (patch.scopeId !== undefined && (patch.scopeId || null) !== (meta.scopeId || null)) return false;
      const incomingAt = time(patch.updatedAt) || time(meta.updatedAt);
      if (time(meta.updatedAt) > incomingAt) return { ...meta, applied: false, stale: true };
      // The patch must apply to the snapshot it was derived from; otherwise a
      // newer native state is still missing and only a full build is correct.
      if (patch.baseUpdatedAt !== undefined ? time(meta.updatedAt) !== time(patch.baseUpdatedAt) && time(meta.updatedAt) !== incomingAt
        : generation !== generations.bookmarks) return false;
      const store = tx.objectStore('bookmarkNodes'), queries = tx.objectStore('bookmarkQueries'), extras = tx.objectStore('bookmarkTermExtras');
      const blocks = new Map(), added = new Map(), affected = new Set();
      let patched = 0;
      for (const [id, record] of changes) {
        const row = await request(store.get([gen, id]));
        if (!row?.url) continue;
        // The same rule as the native mirror: a cached preview belongs to the
        // page only while its URL still matches.
        const preview = record && record.url === row.url ? record : undefined;
        const before = row.searchText || '', wasImage = hasImage(row);
        const oldDescription = String(row.preview?.description || '').toLocaleLowerCase();
        // The description is the last field of the prepared text. Anything else
        // aborts the whole patch; the caller then schedules a full build.
        if (!before.endsWith(` ${oldDescription}`)) throw Error('bookmarkIndexMismatch');
        const base = before.slice(0, before.length - oldDescription.length);
        if (preview) row.preview = preview; else delete row.preview;
        row.searchText = base + String(preview?.description || '').toLocaleLowerCase();
        store.put(row); patched++;
        if (row.searchText !== before) {
          const known = new Set(textGrams(before));
          for (const key of textGrams(row.searchText)) if (!known.has(key)) {
            if (!added.has(key)) added.set(key, []);
            added.get(key).push(row.position);
          }
          const blockKey = Math.floor(row.position / QUERY_BLOCK_SIZE);
          if (!blocks.has(blockKey)) blocks.set(blockKey, await request(queries.get([gen, blockKey])));
          const entry = blocks.get(blockKey)?.rows.find(item => item.id === row.id);
          if (entry) entry.searchText = row.searchText;
        }
        if (wasImage !== hasImage(row)) {
          const folder = await request(store.get([gen, row.parentId]));
          if (folder && !folder.url) {
            const direct = (folder.directImages || []).filter(([pageId]) => pageId !== row.id);
            if (hasImage(row)) { direct.push([row.id, row.position]); direct.sort((a, b) => a[1] - b[1]); }
            folder.directImages = direct; store.put(folder); affected.add(folder.id);
          }
        }
      }
      for (const block of blocks.values()) if (block) queries.put(block);
      for (const [key, positions] of added) {
        const row = await request(extras.get([gen, key]));
        extras.put({ gen, key, positions: new Uint32Array(mergeSorted(row?.positions, positions.sort((a, b) => a - b))) });
      }
      // Re-select each affected folder's top three from bounded reads, then
      // its ancestors until a mosaic is unchanged.
      for (const id of affected) {
        const seen = new Set();
        for (let folder = await request(store.get([gen, id])); folder && !folder.url && !seen.has(folder.id); folder = folder.parentId ? await request(store.get([gen, folder.parentId])) : null) {
          seen.add(folder.id);
          const covers = folder.directImages || [], coverIds = new Set(covers.map(([pageId]) => pageId));
          const [direct, subfolders] = await Promise.all([
            request(store.index('parent').getAll(parentRange(gen, 'page', folder.id), 3 + covers.length)),
            request(store.index('parent').getAll(parentRange(gen, 'folder', folder.id)))]);
          const sequence = covers.slice(0, 3).map(([pageId, at]) => ({ id: pageId, image: true, at, order: 0 }));
          for (const page of direct.filter(page => !coverIds.has(page.id)).slice(0, 3)) sequence.push({ id: page.id, image: false, at: page.position, order: 0 });
          for (const sub of subfolders) (sub.summary?.previewIds || []).forEach((pageId, index) =>
            sequence.push({ id: pageId, image: !!sub.summary.previewImages?.[index], at: sub.position, order: index + 1 }));
          sequence.sort((a, b) => a.at - b.at || a.order - b.order);
          const top = topPreviews(sequence);
          if (sameTop(folder.summary, top)) break;
          folder.summary = { ...folder.summary, ...top }; store.put(folder);
        }
      }
      const next = { ...meta, updatedAt: Math.max(time(meta.updatedAt), incomingAt), signature: patch.signature ?? meta.signature ?? null,
        revision: time(meta.revision) + 1 };
      infoStore.put(next);
      return { ...next, applied: true, patched };
    }));
  }
  async function bookmarkView(options = {}, context = {}) {
    if (!supported()) return null;
    let selected = typeof options.selected === 'string' ? options.selected : '';
    const query = String(options.query || '').trim().toLocaleLowerCase();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 48));
    const folderLimit = Math.max(1, Math.min(500, Number(options.folderLimit) || 24));
    const usable = meta => !!meta?.ready && published(meta) && context.bookmarkPermission === true && context.bookmarkConfig?.enabled === true
      && (context.bookmarkConfig.scopeId || null) === (meta.scopeId || null) && !!meta.enabled && !meta.error;
    // A metadata-only transaction first: when no usable snapshot exists the
    // caller learns it at once instead of queuing a read transaction over the
    // data stores behind an initial build's writes.
    const first = await meta('bookmarks');
    if (!usable(first)) return null;
    return transaction(['bookmarkMeta', 'bookmarkNodes', 'bookmarkTerms', 'bookmarkTermExtras', 'bookmarkQueries'], 'readonly', async tx => {
      // Re-read inside the data transaction: rows always come from the
      // generation that is published while this transaction runs.
      const meta = await readMeta(tx, 'bookmarks');
      if (!usable(meta)) return null;
      const store = tx.objectStore('bookmarkNodes'), gen = meta.generation;
      const folders = await request(store.index('kind').getAll([gen, 'folder']));
      const folderMap = new Map(folders.map(node => [node.id, node]));
      const inside = (node, root = selected) => {
        if (!root) return true;
        const seen = new Set();
        for (let current = node; current && !seen.has(current.id); current = folderMap.get(current.parentId)) {
          if (current.parentId === root || current.id === root) return true;
          seen.add(current.id);
        }
        return false;
      };
      const matches = node => (node.searchText || '').includes(query);
      if (selected && (!folderMap.has(selected) || !inside(folderMap.get(selected), meta.scopeId))) selected = '';
      let pages, totalPages;
      if (query) {
        const keys = query.length >= 3 ? new Set([`g:${query.slice(0, 3)}`, `g:${query.slice(-3)}`])
          : new Set([...grams(query, 1)].map(letter => `c:${letter}`));
        const terms = tx.objectStore('bookmarkTerms'), extras = tx.objectStore('bookmarkTermExtras');
        const lists = await Promise.all([...keys].map(async key => {
          const [main, extra] = await Promise.all([request(terms.get([gen, key])), request(extras.get([gen, key]))]);
          return mergeSorted(main?.positions || [], extra?.positions);
        }));
        lists.sort((a, b) => a.length - b.length);
        let candidates = lists[0] || [];
        for (let i = 1; i < lists.length && candidates.length; i++) candidates = intersection(candidates, lists[i]);
        const queries = tx.objectStore('bookmarkQueries');
        const dense = candidates.length > meta.totalPages / 5;
        const blocks = dense ? await request(queries.getAll(IDBKeyRange.bound([gen, 0], [gen, MAX]))) : (await Promise.all(
          [...new Set(Array.from(candidates, position => Math.floor(position / QUERY_BLOCK_SIZE)))].map(key => request(queries.get([gen, key])))
        )).filter(Boolean);
        const allowed = dense ? null : new Set(candidates), visible = [];
        totalPages = 0;
        // Block keys and rows retain native order, so ranking does not need
        // another full result array or sort. Totals still count every match.
        for (const block of blocks) for (const node of block.rows) {
          if (allowed && !allowed.has(node.position)) continue;
          if (!inside(node) || !matches(node)) continue;
          totalPages++;
          if (visible.length < limit) visible.push(node.id);
        }
        pages = (await Promise.all(visible.map(id => request(store.get([gen, id]))))).filter(Boolean);
      } else if (selected) {
        const key = parentRange(gen, 'page', selected);
        [pages, totalPages] = await Promise.all([request(store.index('parent').getAll(key, limit)), request(store.index('parent').count(key))]);
      } else {
        pages = await request(store.index('recent').getAll(IDBKeyRange.bound([gen, 'page', -Number.MAX_VALUE, 0], [gen, 'page', 0, MAX]), limit));
        totalPages = meta.totalPages;
      }
      const scopedFolders = folders.filter(node => inside(node, meta.scopeId));
      const scopedMap = new Map(scopedFolders.map(node => [node.id, node]));
      const folderNodes = scopedFolders.filter(node => selected ? node.parentId === selected : node.id === meta.scopeId || !scopedMap.has(node.parentId))
        .filter(node => !query || matches(node)).sort((a, b) => a.position - b.position);
      const previewIds = [...new Set(folderNodes.slice(0, folderLimit).flatMap(node => node.summary?.previewIds || []))];
      const previews = (await Promise.all(previewIds.map(id => request(store.get([gen, id]))))).filter(Boolean);
      const byId = new Map([...pages, ...previews].map(node => [node.id, node]));
      const clean = row => { const { gen: generation, kind, recent, position, searchText, urlKey: key, directImages, ...node } = row; return node; };
      const cleanFolders = folders.map(row => ({ ...clean(row), summary: { ...row.summary,
        previews: (row.summary?.previewIds || []).map(id => byId.get(id)).filter(Boolean).map(clean) } }));
      return { enabled: true, scopeId: meta.scopeId, error: null, updatedAt: meta.updatedAt, revision: meta.revision,
        folders: cleanFolders, nodes: [...cleanFolders.filter(node => scopedMap.has(node.id)), ...pages.map(clean)],
        view: { selected, query, totalPages, totalFolders: folderNodes.length, shownPages: pages.length, limit, folderLimit }, partial: true };
    });
  }
  async function membership(urls, context = {}) {
    if (!supported()) return null;
    return transaction(['bookmarkMeta', 'bookmarkNodes'], 'readonly', async tx => {
      const meta = await readMeta(tx, 'bookmarks');
      const granted = meta?.ready && published(meta) && meta.enabled && !meta.error && context.bookmarkPermission === true
        && context.bookmarkConfig?.enabled === true && (context.bookmarkConfig.scopeId || null) === (meta.scopeId || null);
      if (!granted) return { matches: [], updatedAt: meta?.updatedAt || 0 };
      const keys = [...new Set(Array.isArray(urls) ? urls.filter(url => typeof url === 'string') : [])].slice(0, 200), index = tx.objectStore('bookmarkNodes').index('url');
      const matches = await Promise.all(keys.map(async url => await request(index.getKey([meta.generation, urlKey(url)])) === undefined ? null : url));
      return { matches: matches.filter(Boolean), updatedAt: meta.updatedAt };
    });
  }
  globalThis.LaterOnLocalIndex = { supported, info, markDirty, putSearchSource, search, getEntry, putBookmarkState, patchBookmarkPreviews, bookmarkView, membership, bookmarkSearchSource, idle };
})();

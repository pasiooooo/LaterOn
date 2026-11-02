// Optional, device-local presentation data; never written to native bookmarks.
(() => {
  const KEY = 'laterOnBookmarkPreviews', MAX_ENTRIES = 300, MAX_CACHE = 8 * 1024 * 1024;
  const MAX_HTML = 256 * 1024, MAX_IMAGE = 4 * 1024 * 1024, MAX_THUMBNAIL = 512 * 1024;
  let cacheQueue = Promise.resolve(), active = 0, epoch = 0;
  const waiting = [], pending = new Map(), controllers = new Set();
  const serial = task => { const work = cacheQueue.then(task); cacheQueue = work.catch(() => {}); return work; };
  function publicUrl(value) {
    try {
      const url = new URL(value), host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host || !host.includes('.') && !host.includes(':')) return '';
      if (/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|corp|lan|home|arpa|invalid|onion)$/.test(host)) return '';
      if (host.includes(':')) {
        // Only global unicast literals; reject transition, documentation and special-use ranges.
        if (!/^[23][0-9a-f]{3}:/i.test(host) || /^(?:2002:|3ff[ef]:|2001::|2001:(?:0|2|10|20|db8):)/i.test(host)) return '';
      } else if (/^\d+(?:\.\d+){3}$/.test(host)) {
        const [a,b] = host.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0) return '';
      }
      return url.href;
    } catch { return ''; }
  }
  const localImage = value => typeof value === 'string' && value.length <= 768 * 1024 && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(value) ? value : '';
  const canonical = value => { try { return new URL(value).href; } catch { return ''; } };
  function budget(value, nodes) {
    const ids = new Map(nodes.filter(node => node.url).map(node => [node.id, node.url]));
    const entries = Object.entries(value).filter(([id, item]) => ids.get(id) === item?.url).sort((a,b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    const result = {}; let bytes = 0;
    for (const [id, item] of entries) {
      const size = JSON.stringify(item).length * 2;
      if (Object.keys(result).length >= MAX_ENTRIES || bytes + size > MAX_CACHE) continue;
      result[id] = item; bytes += size;
    }
    return result;
  }
  function read(nodes) {
    return serial(async () => {
      const stored = await chrome.storage.local.get([KEY, 'laterOnItems', 'laterOnCovers']);
      const previous = stored[KEY] || {}, next = { ...previous };
      const reading = new Map((stored.laterOnItems || []).map(item => [canonical(item.url), item]));
      for (const node of nodes) {
        if (!node.url) continue;
        const old = next[node.id]?.url === node.url ? next[node.id] : {};
        const item = reading.get(canonical(node.url));
        if (!item) continue;
        const image = localImage(item.image?.startsWith('local://') ? stored.laterOnCovers?.[item.image.slice(8)] : item.image);
        const description = typeof item.description === 'string' && item.description !== '暂无摘要' ? item.description.slice(0, 600) : '';
        const sourceImage = publicUrl(item.image);
        if ((!old.image && image) || (!old.description && description) || (!old.image && sourceImage && sourceImage !== old.sourceImage)) {
          next[node.id] = { ...old, url: node.url, image: old.image || image, description: old.description || description,
            sourceImage, updatedAt: Date.now(), local: true, failed: false };
        }
      }
      const trimmed = budget(next, nodes);
      if (JSON.stringify(trimmed) !== JSON.stringify(previous)) await chrome.storage.local.set({ [KEY]: trimmed });
      return trimmed;
    });
  }
  function commit(records, nodes, generation) {
    return serial(async () => {
      if (generation !== epoch) return;
      const stored = await chrome.storage.local.get(KEY), next = { ...(stored[KEY] || {}) };
      for (const record of records) {
        if (!nodes.some(node => node.id === record.id && node.url === record.url)) continue;
        const old = next[record.id]?.url === record.url ? next[record.id] : {};
        next[record.id] = { ...old, url: record.url, image: record.image || old.image || '', description: record.description || old.description || '',
          failed: !!record.error || !record.image && !record.description, attemptedAt: Date.now(), updatedAt: Date.now() };
      }
      if (generation === epoch) await chrome.storage.local.set({ [KEY]: budget(next, nodes) });
    });
  }
  function limit(task) {
    return new Promise((resolve, reject) => {
      const start = async () => { active++; try { resolve(await task()); } catch (error) { reject(error); } finally { active--; waiting.shift()?.(); } };
      if (active < 2) start(); else waiting.push(start);
    });
  }
  async function thumbnail(bytes, type) {
    if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
      const bitmap = await createImageBitmap(new Blob([bytes], { type }));
      try {
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40 * 1024 * 1024) throw new Error('bookmarkPreviewUnavailable');
        const scale = Math.min(1, 1024 / bitmap.width, 1024 / bitmap.height);
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
        if (blob.size > MAX_THUMBNAIL) throw new Error('bookmarkPreviewUnavailable');
        bytes = new Uint8Array(await blob.arrayBuffer()); type = blob.type;
      } finally { bitmap.close(); }
    } else if (bytes.length > MAX_THUMBNAIL) throw new Error('bookmarkPreviewUnavailable');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return localImage(`data:${type};base64,${btoa(binary)}`);
  }
  async function request(value, image, generation, guard) {
    const url = publicUrl(value);
    if (!url || generation !== epoch) throw new Error('bookmarkPreviewUnavailable');
    await guard();
    if (generation !== epoch) throw new Error('bookmarkPreviewUnavailable');
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
      const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      const supported = image ? /^image\/(?:png|jpeg|webp|gif|avif)$/.test(type) : type === 'text/html';
      if (!response.ok || !supported) throw new Error('bookmarkPreviewUnavailable');
      if (!response.body?.getReader) throw new Error('bookmarkPreviewUnavailable');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      const maximum = image ? MAX_IMAGE : MAX_HTML;
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (size + chunk.byteLength > maximum) {
          if (image) { await reader.cancel(); throw new Error('bookmarkPreviewUnavailable'); }
          chunks.push(chunk.slice(0, maximum - size)); size = maximum;
          await reader.cancel(); break;
        }
        chunks.push(chunk); size += chunk.byteLength;
      }
      if (generation !== epoch || controller.signal.aborted) throw new Error('bookmarkPreviewUnavailable');
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (!image) return new TextDecoder().decode(bytes);
      const converted = await thumbnail(bytes, type);
      if (generation !== epoch || controller.signal.aborted) throw new Error('bookmarkPreviewUnavailable');
      return converted;
    } finally { clearTimeout(timer); controller.abort(); controllers.delete(controller); }
  }
  const ready = tab => tab && !tab.discarded && !tab.frozen && !tab.pendingUrl && tab.status === 'complete';
  async function rendered(node, tabs, generation, guard) {
    if (typeof extractTabMetadata !== 'function') return {};
    try {
      const tab = (await tabs).find(tab => ready(tab) && canonical(tab.url) === canonical(node.url));
      if (!tab) return {};
      await guard(node);
      const before = await chrome.tabs.get(tab.id);
      if (generation !== epoch || !ready(before) || canonical(before.url) !== canonical(node.url)) return {};
      // The same read-only extractor as "Add current page", without its unbounded server rescue.
      const metadata = await extractTabMetadata(before, { serverRescue: false });
      const after = await chrome.tabs.get(tab.id);
      if (generation !== epoch || !ready(after) || canonical(after.url) !== canonical(node.url) || canonical(metadata?.url) !== canonical(node.url)) return {};
      return metadata || {};
    } catch { return {}; }
  }
  function load(nodes, guard) {
    const generation = epoch;
    const tabs = typeof extractTabMetadata === 'function' && chrome.tabs?.query
      ? chrome.tabs.query({ status: 'complete', discarded: false }).catch(() => []) : Promise.resolve([]);
    return Promise.all(nodes.slice(0, 12).map(node => {
      const key = `${generation}:${node.id}:${node.url}`;
      if (pending.has(key)) return pending.get(key);
      const job = limit(async () => {
        try {
          if (!publicUrl(node.url) || generation !== epoch) throw new Error('bookmarkPreviewUnavailable');
          await guard(node);
          if (generation !== epoch) throw new Error('bookmarkPreviewUnavailable');
          const metadata = await rendered(node, tabs, generation, guard);
          let description = typeof metadata.description === 'string' && metadata.description !== '暂无摘要' ? metadata.description.slice(0, 600) : '';
          let image = localImage(metadata.image);
          const stored = (await chrome.storage.local.get(KEY))[KEY]?.[node.id];
          const tried = new Set();
          const getImage = async candidate => {
            const url = publicUrl(candidate);
            if (image || !url || url === node.url || tried.has(url) || LaterOnPageMetadata.isGenericImage(url)) return;
            tried.add(url);
            try { image = await request(url, true, generation, () => guard(node)); } catch {}
          };
          await getImage(metadata.image);
          if (stored?.url === node.url) await getImage(stored.sourceImage);
          if (!image || !description) {
            try {
              const html = await request(node.url, false, generation, () => guard(node));
              const fallback = LaterOnPageMetadata.parse(html, node.url);
              description ||= fallback.description.slice(0, 600);
              await getImage(fallback.image);
            } catch {}
          }
          if (!image && !description) throw new Error('bookmarkPreviewUnavailable');
          return { id: node.id, url: node.url, image, description };
        } catch { return { id: node.id, url: node.url, error: 'bookmarkPreviewUnavailable' }; }
      }).finally(() => pending.delete(key));
      pending.set(key, job); return job;
    }));
  }
  function cancel() { epoch++; for (const controller of controllers) controller.abort(); }
  globalThis.LaterOnBookmarkPreviews = { read, commit, load, cancel, publicUrl, localImage, get epoch() { return epoch; } };
})();

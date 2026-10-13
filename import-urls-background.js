// URL-list imports use the same commit queue as saves and WebDAV application.
// Persist the URLs and their metadata jobs together before acknowledging import.
(function () {
  const MAX_BYTES = 5 * 1024 * 1024;
  function parse(text) {
    if (typeof text !== "string") throw new Error("urlImportEmpty");
    if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("urlImportTooLarge");
    const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error("urlImportEmpty");
    const urls = [];
    let invalid = 0;
    for (const line of lines) {
      try {
        // Requiring one complete URL avoids accidentally accepting two links,
        // prose, or browser-internal/script URLs as a single saved page.
        if (!/^https?:\/\/[^/\\\s]/i.test(line) || /[\s\x00-\x1f\x7f\\]/.test(line)) throw new Error();
        const url = new URL(line);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error();
        urls.push({ url: url.href, source: url.hostname });
      } catch { invalid++; }
    }
    return { urls, invalid };
  }
  async function importText(text) {
    const { urls, invalid } = parse(text);
    const result = await queueItemWrite(async () => {
      try {
        const metadata = LaterOnImportMetadata;
        const stored = await chrome.storage.local.get(["laterOnItems", metadata.KEY]);
        const existing = stored.laterOnItems || [];
        const seen = new Map(existing.map(item => [LaterOnUrl.normalize(item.url), item]));
        const targets = new Map();
        const added = [];
        let duplicates = 0;
        const now = Date.now();
        for (const entry of urls) {
          const key = LaterOnUrl.normalize(entry.url);
          if (seen.has(key)) { duplicates++; targets.set(seen.get(key).id, seen.get(key)); continue; }
          added.push({
            id: crypto.randomUUID(), url: entry.url, title: entry.url,
            description: "", image: "", favicon: "", source: entry.source,
            projectId: null, savedAt: now - added.length, status: "unread", read: false, doneAt: null
          });
          const item = added[added.length - 1];
          seen.set(key, item);
          targets.set(item.id, item);
        }
        const queued = metadata.enqueue(stored[metadata.KEY], [...targets.values()]);
        const patch = {};
        if (added.length) patch.laterOnItems = [...added, ...existing];
        if (queued.count) patch[metadata.KEY] = queued.state;
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
        return { ok: true, added: added.length, duplicates, invalid, total: existing.length + added.length, enrichmentQueued: queued.count };
      } catch { throw new Error("urlImportSaveFailed"); }
    });
    LaterOnImportMetadata.kick();
    return result;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "IMPORT_URL_LINES") return;
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("settings.html")) {
      sendResponse({ ok: false, error: "urlImportForbidden" });
      return;
    }
    importText(message.text).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();

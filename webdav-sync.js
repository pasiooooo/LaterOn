// WebDAV transport lives only in the extension service worker. Credentials never
// enter the sync document, exports, page scripts, URLs or diagnostic messages.
(function () {
  const Core = globalThis.LaterOnSyncCore;
  const CONFIG = "laterOnWebDAV", STATE = "laterOnSyncState", STATUS = "laterOnSyncStatus";
  const APPLIED = "laterOnSyncApplied", ALARM = "laterOnWebDAVSync";
  const FILE = "lateron-sync-v1.json", MAX_BYTES = 50 * 1024 * 1024;
  let localQueue = Promise.resolve(), active = null, debounce = null, generation = 0;
  const controllers = new Set();
  let rerun = false;
  const serial = task => {
    // Share the short local commit queue with saves, item mutations and cleanup;
    // network requests never hold this queue.
    const run = () => typeof queueItemWrite === "function" ? queueItemWrite(task) : task();
    const pending = localQueue.then(run);
    localQueue = pending.catch(() => {});
    return pending;
  };
  function configValue(raw, stored = false) {
    const config = { enabled: !!raw?.enabled, url: String(raw?.url || "").trim(), username: String(raw?.username || ""), password: String(raw?.password || ""),
      directoryMode: stored && raw?.directoryMode !== "auto" ? "legacy" : "auto" };
    if (!config.url && !config.enabled) return config;
    let url;
    try { url = new URL(config.url); } catch { throw new Error("syncInvalidUrl"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || config.username.includes(":")) throw new Error("syncInvalidUrl");
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    config.url = url.href;
    return config;
  }
  function directoryUrl(config) {
    // Old saved configurations already point at their data directory. Keep
    // reading them there until the user explicitly saves the new settings.
    if (!config.url || config.directoryMode === "legacy" || new URL(config.url).pathname.endsWith("/LaterOn/")) return config.url;
    return new URL("LaterOn/", config.url).href;
  }
  async function status(patch) {
    const old = (await chrome.storage.local.get(STATUS))[STATUS] || {};
    await chrome.storage.local.set({ [STATUS]: { ...old, ...patch } });
  }
  function errorCode(error) {
    const message = String(error?.message || "");
    return /^sync[A-Za-z]+$/.test(message) || /^HTTP \d{3}$/.test(message) ? message : "syncNetworkError";
  }
  async function commit(doc, device) {
    const next = Core.materialize(doc);
    const current = await chrome.storage.local.get(Core.KEYS);
    const patch = { [STATE]: { device, doc }, [APPLIED]: crypto.randomUUID() };
    for (const key of Core.KEYS) if (!Core.equal(current[key] ?? (Array.isArray(next[key]) ? [] : {}), next[key])) patch[key] = next[key];
    await chrome.storage.local.set(patch);
  }
  async function readCurrentState() {
    const stored = await chrome.storage.local.get([...Core.KEYS, STATE]);
    const state = stored[STATE];
    if (!state) throw new Error("syncLocalError");
    const data = Object.fromEntries(Core.KEYS.map(key => [key, stored[key] ?? (key === "laterOnItems" || key === "laterOnProjects" ? [] : {})]));
    // Also recover user writes whose journal persistence failed in this worker.
    // Data and journal commits are atomic, so any difference is a local edit.
    return { device: state.device, doc: Core.change(state.doc, Core.materialize(state.doc), data, state.device) };
  }
  async function initialize() {
    return serial(async () => {
      const stored = await chrome.storage.local.get([...Core.KEYS, STATE, CONFIG]);
      if (!stored[STATE] && !stored[CONFIG]?.enabled) return;
      const device = stored[STATE]?.device || crypto.randomUUID();
      const doc = stored[STATE]?.doc;
      const data = Object.fromEntries(Core.KEYS.map(key => [key, stored[key] ?? (key === "laterOnItems" || key === "laterOnProjects" ? [] : {})]));
      // Repair the journal if the worker stopped after a user write but before
      // its storage change event was recorded.
      const next = doc ? Core.change(doc, Core.materialize(doc), data, device) : Core.seed(data, device);
      await commit(next, device);
    });
  }
  async function scheduleAlarm(enabled) {
    if (!enabled) { await chrome.alarms.clear(ALARM); return; }
    if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.5 });
  }
  function soon() {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; sync().catch(() => {}); }, 1200);
    // The persistent alarm is the fallback if MV3 suspends this timer.
  }
  const ready = initialize();
  ready.catch(() => status({ phase: "error", error: "syncLocalError" }).catch(() => {}));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || changes[APPLIED] || !Core.KEYS.some(key => changes[key])) return;
    serial(async () => {
      const stored = await chrome.storage.local.get([STATE]);
      const state = stored[STATE];
      if (!state) return;
      const before = {}, after = {};
      for (const key of Core.KEYS) if (changes[key]) {
        before[key] = changes[key].oldValue;
        after[key] = changes[key].newValue;
      }
      // Record the actual event delta, not a whole stale snapshot. This also
      // recovers a UI write that raced with applying a remote snapshot.
      const next = Core.change(state.doc, before, after, state.device);
      await commit(next, state.device);
      soon();
    }).catch(() => status({ phase: "error", error: "syncLocalError" }).catch(() => {}));
  });
  function authorization(config) {
    const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
    let value = "";
    for (const byte of bytes) value += String.fromCharCode(byte);
    return `Basic ${btoa(value)}`;
  }
  async function request(config, method, headers = {}, body, path = FILE, epoch = generation) {
    if (epoch !== generation) throw new Error("syncCancelled");
    const abort = new AbortController();
    controllers.add(abort);
    const timeout = setTimeout(() => abort.abort(), 20000);
    try {
      const response = await fetch(new URL(path, directoryUrl(config)).href, {
        method, headers: { Authorization: authorization(config), ...headers }, body,
        signal: abort.signal, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer"
      });
      // Consume the body under the same timeout, so a stalled download cannot
      // keep a sync in progress indefinitely.
      if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("syncTooLarge");
      let text = "";
      if ((method === "GET" || method === "PROPFIND") && response.ok) {
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let size = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) { await reader.cancel(); throw new Error("syncTooLarge"); }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } else text = await response.text();
      } else await response.body?.cancel();
      if (epoch !== generation) throw new Error("syncCancelled");
      return { status: response.status, ok: response.ok, etag: response.headers.get("etag"), text };
    } catch (error) {
      if (epoch !== generation) throw new Error("syncCancelled");
      if (abort.signal.aborted) throw new Error("syncTimeout");
      throw error;
    } finally {
      clearTimeout(timeout);
      controllers.delete(abort);
    }
  }
  function httpError(code) {
    if (code === 401 || code === 403) return new Error("syncAuthError");
    if (code === 409) return new Error("syncDirectoryMissing");
    return new Error(`HTTP ${code}`);
  }
  async function ensureDirectory(config, epoch) {
    if (config.directoryMode === "legacy") return;
    const response = await request(config, "MKCOL", {}, undefined, "", epoch);
    // MKCOL returns 405 for an existing collection, including another device
    // creating it concurrently. Subsequent file requests verify usability.
    if (!response.ok && response.status !== 405) throw httpError(response.status);
  }
  function parseRemote(response) {
    if (!response.ok) throw httpError(response.status);
    let doc;
    try { doc = JSON.parse(response.text); } catch { throw new Error("syncInvalidData"); }
    return Core.validate(doc);
  }
  async function listSnapshots(config, epoch) {
    let response = await request(config, "PROPFIND", { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', "", epoch);
    if (response.status === 404 && config.directoryMode !== "legacy") {
      await ensureDirectory(config, epoch);
      response = await request(config, "PROPFIND", { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', "", epoch);
    }
    if ([405, 501].includes(response.status)) throw new Error("syncListUnsupported");
    if (!response.ok) throw httpError(response.status);
    return LaterOnWebDAVDirectory.names(response.text, directoryUrl(config));
  }
  async function exchange(config, epoch) {
    // Immutable, random snapshot names eliminate the shared-file write race.
    // ETags and conditional PUT support are deliberately not required.
    for (let attempt = 0; attempt < 4; attempt++) {
      const names = await listSnapshots(config, epoch);
      const snapshots = [];
      let remote = Core.empty(), retry = false;
      for (const name of names) {
        const response = await request(config, "GET", {}, undefined, name, epoch);
        // Another device may have compacted this snapshot after our listing.
        // Refresh the listing before activating any new-device seed records.
        if (response.status === 404) { retry = true; break; }
        const doc = parseRemote(response);
        remote = Core.merge(remote, doc);
        snapshots.push({ name, doc });
      }
      if (retry) continue;
      const local = await serial(async () => {
        if (epoch !== generation) throw new Error("syncCancelled");
        return readCurrentState();
      });
      const merged = Core.validate(Core.activate(Core.merge(local.doc, remote), local.device));
      let retained = snapshots.find(entry => entry.name !== FILE && Core.equal(entry.doc, merged))?.name;
      if (!retained) {
        const body = JSON.stringify(merged);
        if (new TextEncoder().encode(body).length > MAX_BYTES) throw new Error("syncTooLarge");
        retained = `lateron-snapshot-v2-${crypto.randomUUID()}.json`;
        const result = await request(config, "PUT", { "Content-Type": "application/json; charset=utf-8" }, body, retained, epoch);
        if (!result.ok) throw httpError(result.status);
        // Read back before pruning anything. An interrupted upload or failed
        // verification leaves all prior snapshots and the local journal intact.
        const verify = await request(config, "GET", {}, undefined, retained, epoch);
        if (!verify.ok) throw httpError(verify.status);
        if (verify.text !== body) {
          // Only this run owns the fresh UUID. Remove its corrupt upload so it
          // cannot block later merges; all previous snapshots are still intact.
          await request(config, "DELETE", {}, undefined, retained, epoch).catch(() => {});
          throw new Error("syncVerifyFailed");
        }
      }
      await serial(async () => {
        if (epoch !== generation) throw new Error("syncCancelled");
        const latest = await readCurrentState();
        const final = Core.merge(latest.doc, merged);
        await commit(final, latest.device);
        if (!Core.equal(final, merged)) rerun = true;
      });
      // Only the exact immutable snapshots read above are eligible for cleanup:
      // their records/tombstones are already covered by the verified successor.
      // Never delete a concurrent publication, the v1 file, or unrelated files.
      let cleanupPending = false;
      for (const entry of snapshots) {
        if (entry.name === FILE || entry.name === retained) continue;
        try {
          const removed = await request(config, "DELETE", {}, undefined, entry.name, epoch);
          if (!removed.ok && removed.status !== 404) cleanupPending = true;
        } catch (error) {
          if (epoch !== generation) throw error;
          cleanupPending = true;
        }
      }
      return { cleanupPending };
    }
    throw new Error("syncConflict");
  }
  async function sync() {
    if (active) { rerun = true; return active; }
    const epoch = generation;
    const work = async () => {
      await ready;
      const raw = (await chrome.storage.local.get(CONFIG))[CONFIG];
      if (!raw?.enabled) return { ok: true, disabled: true };
      const config = configValue(raw, true);
      await status({ phase: "syncing", error: null });
      try {
        const result = await exchange(config, epoch);
        if (epoch === generation) await status({ phase: "success", lastSuccess: Date.now(), error: null, cleanupPending: result.cleanupPending });
        return { ok: true };
      } catch (error) {
        if (epoch === generation) await status({ phase: "error", error: errorCode(error) });
        return { ok: false, error: errorCode(error) };
      }
    };
    active = work().finally(() => {
      active = null;
      if (rerun) { rerun = false; soon(); }
    });
    return active;
  }
  async function saveConfig(raw) {
    const config = configValue(raw);
    // Verify directory enumeration and round-trip file access before enabling.
    if (config.enabled) await testConnection(config);
    generation++;
    for (const controller of controllers) controller.abort();
    if (debounce !== null) { clearTimeout(debounce); debounce = null; }
    await ready;
    await serial(async () => {
      const stored = await chrome.storage.local.get([CONFIG, STATE, ...Core.KEYS]);
      const device = stored[STATE]?.device || crypto.randomUUID();
      const previous = stored[CONFIG]?.url ? configValue(stored[CONFIG], true) : null;
      const changedServer = !previous || directoryUrl(previous) !== directoryUrl(config) || previous.username !== config.username;
      const patch = { [CONFIG]: config, [STATUS]: { phase: config.enabled ? "pending" : "disabled", error: null,
        lastSuccess: changedServer ? null : (await chrome.storage.local.get(STATUS))[STATUS]?.lastSuccess || null } };
      // Tombstones from one account must never delete data in another account.
      if (!stored[STATE] || changedServer) patch[STATE] = { device, doc: Core.seed(stored, device) };
      await chrome.storage.local.set(patch);
    });
    await scheduleAlarm(config.enabled);
    if (config.enabled) soon();
    return { ok: true };
  }
  async function testConnection(raw) {
    const config = configValue({ ...raw, enabled: true });
    // Probe only a disposable resource, never the user's sync snapshots.
    const path = `.lateron-check-${crypto.randomUUID()}.json`;
    const epoch = generation;
    let created = false;
    try {
      await ensureDirectory(config, epoch);
      await listSnapshots(config, epoch);
      const put = await request(config, "PUT", { "Content-Type": "application/json" }, "{}", path, epoch);
      if (!put.ok) throw httpError(put.status);
      created = true;
      const get = await request(config, "GET", {}, undefined, path, epoch);
      if (!get.ok) throw httpError(get.status);
      if (get.text !== "{}") throw new Error("syncVerifyFailed");
      const updatedBody = '{"lateron":"connection-test"}';
      const update = await request(config, "PUT", { "Content-Type": "application/json" }, updatedBody, path, epoch);
      if (!update.ok) throw httpError(update.status);
      const verify = await request(config, "GET", {}, undefined, path, epoch);
      if (!verify.ok) throw httpError(verify.status);
      if (verify.text !== updatedBody) throw new Error("syncVerifyFailed");
      return { ok: true };
    } finally {
      if (created) {
        const removed = await request(config, "DELETE", {}, undefined, path, epoch);
        if (!removed.ok && removed.status !== 404) throw new Error("syncTestCleanup");
      }
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const actions = {
      WEBDAV_SAVE: () => saveConfig(message.config),
      WEBDAV_SYNC: () => sync(),
      WEBDAV_TEST: () => testConnection(message.config)
    };
    if (!actions[message?.type]) return;
    // Configuration and network controls are only callable by the options page.
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("settings.html")) {
      sendResponse({ ok: false, error: "syncForbidden" });
      return;
    }
    Promise.resolve().then(actions[message.type]).then(sendResponse).catch(error => sendResponse({ ok: false, error: errorCode(error) }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) sync().catch(() => {}); });
  async function resume() {
    await ready;
    const enabled = !!(await chrome.storage.local.get(CONFIG))[CONFIG]?.enabled;
    await scheduleAlarm(enabled);
    if (enabled) await sync();
  }
  chrome.runtime.onStartup.addListener(() => resume().catch(() => {}));
  chrome.runtime.onInstalled.addListener(() => resume().catch(() => {}));
  resume().catch(() => {});
})();

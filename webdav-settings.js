(function () {
  const CONFIG = "laterOnWebDAV", STATUS = "laterOnSyncStatus";
  const form = document.querySelector("#webdavForm");
  if (!form) return;
  const t = (key, params) => window.LaterOnI18n?.t(key, params) || key;
  const fields = Object.fromEntries(["enabled", "url", "username", "password"].map(key => [key, form.elements.namedItem(key)]));
  const output = document.querySelector("#webdavStatus");
  const feedback = document.querySelector("#webdavFeedback");
  const syncButton = document.querySelector("#webdavSync");
  const legacyNote = document.querySelector("#webdavLegacyNote");
  let savedEnabled = false, busy = false;
  function showLegacyNote(value) {
    legacyNote.hidden = !value?.url || value.directoryMode === "auto";
  }
  const errorText = code => /^HTTP \d{3}$/.test(code || "") ? t("syncHttpError", { code: code.slice(5) }) : t(code || "syncNetworkError");
  function renderStatus(state = {}) {
    const phase = savedEnabled ? (state.phase || "pending") : "disabled";
    const labels = { disabled: "syncDisabled", pending: "syncPending", syncing: "syncRunning", success: "syncSuccess", error: "syncFailed" };
    let text = t(labels[phase] || "syncPending");
    if (phase === "error") text += ` · ${errorText(state.error)}`;
    if (phase === "success" && state.cleanupPending) text += ` · ${t("syncCleanupPending")}`;
    if (state.lastSuccess) text += ` · ${t("syncLastSuccess", { time: new Date(state.lastSuccess).toLocaleString(document.documentElement.lang) })}`;
    output.removeAttribute("data-i18n");
    output.textContent = text;
    output.dataset.phase = phase;
    syncButton.disabled = busy || !savedEnabled;
  }
  function config() {
    return { enabled: fields.enabled.checked, url: fields.url.value, username: fields.username.value, password: fields.password.value };
  }
  async function action(type) {
    if (busy) return;
    busy = true;
    form.querySelectorAll("button, input").forEach(el => { el.disabled = true; });
    feedback.textContent = t(type === "WEBDAV_TEST" ? "syncTesting" : "processing");
    feedback.dataset.phase = "pending";
    try {
      const result = await chrome.runtime.sendMessage({ type, ...(type === "WEBDAV_SYNC" ? {} : { config: config() }) });
      if (!result?.ok) throw new Error(result?.error || "syncNetworkError");
      if (type === "WEBDAV_SAVE") { savedEnabled = fields.enabled.checked; legacyNote.hidden = true; }
      feedback.textContent = t(type === "WEBDAV_TEST" ? "syncTestSuccess" : type === "WEBDAV_SAVE" ? "syncSaved" : result.disabled ? "syncDisabled" : "syncSuccess");
      feedback.dataset.phase = "success";
    } catch (error) {
      feedback.textContent = errorText(error.message);
      feedback.dataset.phase = "error";
    } finally {
      busy = false;
      form.querySelectorAll("button, input").forEach(el => { el.disabled = false; });
      try { renderStatus((await chrome.storage.local.get(STATUS))[STATUS]); }
      catch { feedback.textContent = t("syncLocalError"); feedback.dataset.phase = "error"; syncButton.disabled = !savedEnabled; }
    }
  }
  form.addEventListener("submit", event => { event.preventDefault(); action("WEBDAV_SAVE"); });
  document.querySelector("#webdavTest").addEventListener("click", () => action("WEBDAV_TEST"));
  syncButton.addEventListener("click", () => action("WEBDAV_SYNC"));
  // An unsaved configuration must never look like it was already applied.
  form.addEventListener("input", () => { feedback.textContent = t("syncUnsaved"); feedback.dataset.phase = "pending"; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[CONFIG]) { savedEnabled = !!changes[CONFIG].newValue?.enabled; showLegacyNote(changes[CONFIG].newValue); }
    if (changes[STATUS]) renderStatus(changes[STATUS].newValue);
  });
  window.addEventListener("lateron-language-change", () => {
    chrome.storage.local.get(STATUS).then(stored => renderStatus(stored[STATUS])).catch(() => {});
  });
  (async () => {
    await window.LaterOnI18n?.getLanguage();
    window.LaterOnI18n?.applyStatic();
    const stored = await chrome.storage.local.get([CONFIG, STATUS]);
    const value = stored[CONFIG] || {};
    showLegacyNote(value);
    fields.enabled.checked = savedEnabled = !!value.enabled;
    for (const key of ["url", "username", "password"]) fields[key].value = value[key] || "";
    renderStatus(stored[STATUS]);
  })().catch(() => { feedback.textContent = t("syncLocalError"); feedback.dataset.phase = "error"; });
})();

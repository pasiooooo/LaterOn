(function () {
  const KEY = "laterOnImportMetadata";
  const output = document.querySelector("#urlImportProgress");
  if (!output) return;
  const t = (key, vars) => window.LaterOnI18n?.t(key, vars) || key;
  function render(state) {
    output.hidden = !state?.total;
    if (!state?.total) return;
    const key = state.phase === "error" ? "urlMetadataRetry"
      : state.pending?.length ? "urlMetadataProgress"
      : state.incomplete ? "urlMetadataPartial" : "urlMetadataComplete";
    output.textContent = t(key, state);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) render(changes[KEY].newValue);
  });
  const refresh = () => chrome.storage.local.get(KEY).then(stored => render(stored[KEY])).catch(() => {});
  window.addEventListener("lateron-language-change", refresh);
  Promise.resolve(window.LaterOnI18n?.ready).then(refresh);
})();

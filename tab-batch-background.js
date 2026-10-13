// Capture the invoking window and selection before the project picker opens.
async function saveAllTabsInWindow(source = "shortcut", commandTab) {
  return saveBrowserTabs("window", commandTab, source);
}

async function saveSelectedTabs(commandTab, source = "shortcut") {
  return saveBrowserTabs("selected", commandTab, source);
}

async function saveCurrentTabGroup(commandTab, source = "shortcut") {
  return saveBrowserTabs("group", commandTab, source);
}

async function saveBrowserTabs(mode, commandTab, source) {
  const tab = commandTab?.id != null ? commandTab
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  const missingWindow = !tab || !Number.isInteger(tab.windowId) || tab.windowId < 0;
  const missingGroup = mode === "group" && (!Number.isInteger(tab?.groupId) || tab.groupId < 0);
  if (missingWindow || missingGroup) {
    const en = await usesEnglish();
    const error = missingWindow
      ? (en ? "No browser window is available. Open a web page and try again." : "没有可用的浏览器窗口，请打开网页后重试")
      : (en ? "This tab is not in a group. Add it to a tab group first." : "当前标签页不属于任何标签组，请先将网页加入标签组");
    await recordDiag({ lastTrigger: source, lastStage: "无法读取标签页", lastError: error, lastErrorAt: Date.now() });
    if (tab?.id != null && isWebUrl(tab.url)) await showPagePills(tab.id, [{ text: error, kind: "skip" }]).catch(() => {});
    else if (mode === "group") await showLibraryCommandNotice(tab, "save-tab-group");
    await showActionError();
    return { ok: false, error, added: 0 };
  }
  const query = { windowId: tab.windowId };
  if (mode === "group") query.groupId = tab.groupId;
  if (mode === "selected") query.highlighted = true;
  const tabs = await chrome.tabs.query(query);
  return saveTabsInScope(source, tabs, tab);
}

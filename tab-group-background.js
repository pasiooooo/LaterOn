// Capture the invoking tab and keep group saves within its browser window.
async function saveCurrentTabGroup(commandTab, source = "shortcut") {
  const tab = commandTab?.id != null ? commandTab
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  // Chrome uses -1 for ungrouped tabs; never query that group as a batch.
  if (!tab || !Number.isInteger(tab.groupId) || tab.groupId < 0 || !Number.isInteger(tab.windowId)) {
    const en = await usesEnglish();
    const message = en ? "This tab is not in a group. Add it to a tab group first."
      : "当前标签页不属于任何标签组，请先将网页加入标签组";
    await recordDiag({ lastTrigger: source, lastStage: "未加入标签组", lastError: message, lastErrorAt: Date.now() });
    if (tab?.id != null && isWebUrl(tab.url)) await showPagePills(tab.id, [{ text: message, kind: "skip" }]).catch(() => {});
    else await showLibraryCommandNotice(tab, "save-tab-group");
    await showActionError();
    return { ok: false, error: message, added: 0 };
  }
  return saveTabsInScope(source, tab);
}


const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8");
const start = source.indexOf("async function openItem(item) {");
const end = source.indexOf("function safeTarget(url) {", start);
assert(start >= 0 && end > start);

async function check(existing) {
  const calls = [];
  let finishMutation;
  const mutation = new Promise(resolve => { finishMutation = resolve; });
  const context = vm.createContext({
    CURRENT_ITEM_KEY: "laterOnCurrentItem", autoMarkRead: true,
    safeTarget: url => url, status: {}, tr: value => value,
    updateItem: (id, patch) => {
      calls.push({ kind: "mutation", id, patch });
      return mutation;
    },
    chrome: {
      storage: { local: { set: () => Promise.resolve() } },
      tabs: { create: async value => { calls.push({ kind: "create", value }); return { id: 91 }; } },
      sidePanel: { open: async value => { calls.push({ kind: "panel", value }); } }
    },
    LaterOnTabs: {
      findOpen: async () => existing,
      activate: async tab => { calls.push({ kind: "activate", id: tab.id }); }
    }
  });
  vm.runInContext(source.slice(start, end), context, { filename: "sidepanel-open-item.js" });
  const opening = context.openItem({ id: "reading-1", url: "https://example.test/reading", status: "unread" });
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(calls[0]?.kind, existing ? "activate" : "create",
    "opening and focusing the article must finish while the storage write is unresolved");
  assert(calls.some(call => call.kind === "mutation"), "automatic reading state still gets saved");
  assert.strictEqual(calls.filter(call => call.kind === "create").length, existing ? 0 : 1,
    "an existing tab must be reused");
  finishMutation(true);
  await opening;
}

(async () => {
  await check({ id: 90, windowId: 7 });
  await check(null);
  console.log("PASS reading articles open before a slow status write, preserving tab reuse");
})().catch(error => { console.error(error); process.exitCode = 1; });

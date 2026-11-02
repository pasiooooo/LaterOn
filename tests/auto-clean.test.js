// Exercise the shipped worker with isolated storage and real change events.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const DAY = 86400000;
const NOW = 1800000000000;
const clone = value => JSON.parse(JSON.stringify(value));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const changed = event();
const alarm = event();
const alarms = [];
const store = { laterOnItems: [], laterOnSettings: {}, laterOnCleanupV165: true };
let failWrite = false;
const local = {
  async get(keys) {
    const names = typeof keys === "string" ? [keys] : keys;
    return clone(Object.fromEntries(names.filter(key => key in store).map(key => [key, store[key]])));
  },
  async set(patch) {
    if (failWrite) { failWrite = false; throw new Error("fixture write failure"); }
    const changes = Object.fromEntries(Object.entries(patch).map(([key, value]) =>
      [key, { oldValue: store[key], newValue: value }]));
    Object.assign(store, clone(patch));
    changed.listeners.forEach(fn => fn(changes, "local"));
  }
};
const chrome = {
  storage: { local, onChanged: changed },
  alarms: { create(name, info) { alarms.push({ name, info }); }, onAlarm: alarm },
  contextMenus: { removeAll(cb) { cb?.(); }, create() {}, onClicked: event() },
  commands: { onCommand: event() },
  runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), getURL: p => `chrome-extension://fixture/${p}` },
  tabs: { onUpdated: event(), onRemoved: event(), onCreated: event() },
  action: {}, sidePanel: { setPanelBehavior() {} }
};
class Clock extends Date { static now() { return NOW; } }
const ctx = vm.createContext({ chrome, console, URL, Date: Clock, setTimeout, clearTimeout, setInterval, clearInterval, importScripts() {} });
vm.runInContext(fs.readFileSync(path.join(ROOT, "url-utils.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), ctx);
const item = (id, days, extra = {}) => ({ id, status: "done", doneAt: NOW - days * DAY, ...extra });
const ids = () => store.laterOnItems.map(it => it.id);
async function drain() {
  for (let i = 0; i < 10; i++) {
    const pending = vm.runInContext("itemWriteQueue", ctx);
    await pending;
    if (pending === vm.runInContext("itemWriteQueue", ctx)) return;
  }
  throw new Error("Cleanup did not settle");
}
(async () => {
  await drain();
  assert(alarms.some(a => a.name === "laterOnAutoClean"));
  for (const value of [undefined, null, "", "  ", -1, "invalid", Infinity, true, [], 1.5]) {
    store.laterOnSettings = value === undefined ? {} : { autoCleanDays: value };
    store.laterOnItems = [item("old", 500)];
    await ctx.purgeExpiredItems();
    assert.deepEqual(ids(), ["old"], `Disabled or invalid value must not delete: ${String(value)}`);
  }
  for (const days of [1, 10, 30, 180, 999, 9999, "7"]) {
    store.laterOnSettings = { autoCleanDays: days };
    store.laterOnItems = [item("expired", Number(days) + 1), item("boundary", Number(days)), item("fresh", Number(days) - 0.5),
      item("reading", 500, { status: "reading" }), item("unread", 500, { status: "unread" })];
    await ctx.purgeExpiredItems();
    await drain();
    assert.deepEqual(ids(), ["fresh", "reading", "unread"], `Honor custom days including exact expiry: ${days}`);
  }
  store.laterOnSettings = { autoCleanDays: 1000000 };
  store.laterOnItems = [item("keep", 500)];
  await ctx.purgeExpiredItems();
  assert.deepEqual(ids(), ["keep"], "Very large retention is not clamped to the former upper limit");
  store.laterOnSettings = { autoCleanDays: 30 };
  store.laterOnItems = [item("missing", 500, { doneAt: null }), { id: "legacy", read: true }];
  await ctx.purgeExpiredItems();
  assert.deepEqual(ids(), ["missing", "legacy"], "Positive retention protects legacy pages without a read timestamp");

  store.laterOnProjects = [{ id: "archive", archived: true }];
  store.laterOnItems = [item("expired", 31, { projectId: "archive" }), item("keep", 1)];
  store.laterOnOrder = { all: ["expired", "keep"], archive: ["expired"] };
  store.laterOnCovers = { expired: "data:expired", keep: "data:keep" };
  store.laterOnCurrentItem = "expired";
  await ctx.purgeExpiredItems();
  await drain();
  assert.deepEqual(ids(), ["keep"]);
  assert.deepEqual(store.laterOnOrder, { all: ["keep"], archive: [] });
  assert.deepEqual(store.laterOnCovers, { keep: "data:keep" });
  assert.equal(store.laterOnCurrentItem, null);
  assert.equal(store.laterOnProjects[0].archived, true);

  store.laterOnItems = [item("now", 0), { id: "legacy", read: true }, item("keep", 1, { status: "reading" })];
  await local.set({ laterOnSettings: { autoCleanDays: 0 } });
  await drain();
  assert.deepEqual(ids(), ["keep"], "Switching to zero immediately removes all read pages, even legacy ones");

  store.laterOnItems = [item("mark", 0, { status: "unread" }), item("keep", 0, { status: "unread" })];
  store.laterOnCovers = { mark: "data:mark" };
  store.laterOnOrder = { all: ["mark", "keep"] };
  store.laterOnCurrentItem = "mark";
  const beforeMark = clone(store);
  failWrite = true;
  await assert.rejects(ctx.mutateItems({ operation: "update", ids: ["mark"], patch: { status: "done" } }), /fixture write failure/);
  assert.deepEqual(store, beforeMark, "Failed immediate deletion preserves items, covers, order and reading marker");
  const result = await ctx.mutateItems({ operation: "update", ids: ["mark"], patch: { status: "done" } });
  assert.deepEqual(Array.from(result.items, it => it.id), ["keep"], "Mark-read response already excludes immediately removed pages");
  await drain();
  assert.deepEqual(ids(), ["keep"]);
  assert.deepEqual(store.laterOnCovers, {});
  assert.deepEqual(store.laterOnOrder, { all: ["keep"] });
  assert.equal(store.laterOnCurrentItem, null);

  store.laterOnItems = [item("batch-a", 0, { status: "unread" }), item("batch-b", 0, { status: "reading" }), item("keep", 0, { status: "unread" })];
  await Promise.all([
    ctx.mutateItems({ operation: "update", ids: ["batch-a", "batch-b"], patch: { status: "done" } }),
    ctx.mutateItems({ operation: "update", ids: ["batch-a"], patch: { status: "reading" } })
  ]);
  await drain();
  assert.deepEqual(ids(), ["keep"], "Batch immediate deletion and queued updates cannot resurrect deleted pages");

  await local.set({ laterOnItems: [item("imported", 0), item("keep", 0, { status: "unread" })] });
  await drain();
  assert.deepEqual(ids(), ["keep"], "Imported or synced read pages are also removed immediately");
  await local.set({ laterOnSettings: { autoCleanDays: null } });
  await drain();
  await local.set({ laterOnItems: [item("retained", 500)] });
  await drain();
  alarm.listeners.forEach(fn => fn({ name: "laterOnAutoClean" }));
  await drain();
  assert.deepEqual(ids(), ["retained"], "Clearing the setting disables item-change and alarm cleanup");

  store.laterOnSettings = { autoCleanDays: 1 };
  const before = clone(store);
  failWrite = true;
  assert.equal(await ctx.purgeExpiredItems(), 0);
  assert.deepEqual(store, before, "Failed cleanup preserves all data");
  await ctx.purgeExpiredItems();
  await drain();
  assert.deepEqual(ids(), [], "Cleanup can retry after failure");
  console.log("PASS auto-clean: disabled default, zero, arbitrary days, exact expiry, legacy safety, change events, atomic deletion and retry");
})().catch(error => { console.error(error); process.exitCode = 1; });

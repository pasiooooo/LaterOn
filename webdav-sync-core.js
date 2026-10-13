// Versioned per-record merge shared by the service worker and deterministic tests.
// Deletion records are intentionally retained: an offline device must not revive them.
(function (root) {
  const KEYS = ["laterOnItems", "laterOnProjects", "laterOnCovers", "laterOnOrder", "laterOnReadingPositions"];
  const GROUPS = [...KEYS, "projectSequence"];
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const safeId = id => typeof id === "string" && id.length > 0 && !["__proto__", "constructor", "prototype"].includes(id);
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  const equal = (a, b) => stable(a) === stable(b);
  const empty = () => ({ type: "lateron-webdav", version: 1, records: Object.fromEntries(GROUPS.map(key => [key, {}])) });
  function mapValues(key, value) {
    if (key === "laterOnItems" || key === "laterOnProjects") {
      return Object.fromEntries((Array.isArray(value) ? value : []).filter(v => safeId(v?.id)).map(v => [v.id, v]));
    }
    return isObject(value) ? value : {};
  }
  function validValue(group, id, value) {
    if (group === "laterOnItems") {
      if (!isObject(value) || value.id !== id || typeof value.url !== "string") return false;
      try { if (!["http:", "https:"].includes(new URL(value.url).protocol)) return false; } catch { return false; }
      return ["title", "description", "image", "favicon", "source"].every(k => value[k] == null || typeof value[k] === "string")
        && (value.projectId == null || typeof value.projectId === "string")
        && (value.status == null || ["unread", "reading", "done"].includes(value.status));
    }
    if (group === "laterOnProjects") return isObject(value) && value.id === id && typeof value.name === "string";
    if (group === "laterOnCovers") return typeof value === "string" && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value);
    if (group === "laterOnReadingPositions") return Number.isFinite(value) && value >= 0;
    return Array.isArray(value) && value.every(safeId);
  }
  function validate(doc) {
    if (!isObject(doc) || doc.type !== "lateron-webdav" || doc.version !== 1 || !isObject(doc.records)
      || Object.keys(doc.records).some(key => !GROUPS.includes(key))) throw new Error("syncInvalidData");
    for (const group of GROUPS) {
      if (!isObject(doc.records[group])) throw new Error("syncInvalidData");
      for (const [id, record] of Object.entries(doc.records[group])) {
        if (!safeId(id) || !isObject(record) || !Array.isArray(record.stamp) || record.stamp.length !== 2
          || !Number.isSafeInteger(record.stamp[0]) || record.stamp[0] < 0 || record.stamp[0] >= Number.MAX_SAFE_INTEGER - 1000000
          || !safeId(record.stamp[1]) || typeof record.deleted !== "boolean"
          || (group === "projectSequence" && id !== "ids")
          || (!record.deleted && !validValue(group, id, record.value))) throw new Error("syncInvalidData");
      }
    }
    return doc;
  }
  function maxClock(doc) {
    let max = 0;
    for (const group of GROUPS) for (const r of Object.values(doc.records[group])) max = Math.max(max, r.stamp[0]);
    return max;
  }
  // A fixed device tie-breaker makes equal-time concurrent writes converge on every device.
  function compare(a, b) {
    return a.stamp[0] - b.stamp[0] || (a.stamp[1] < b.stamp[1] ? -1 : a.stamp[1] > b.stamp[1] ? 1 : 0)
      || (stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0);
  }
  function merge(a, b) {
    const out = empty();
    for (const group of GROUPS) {
      for (const id of new Set([...Object.keys(a.records[group]), ...Object.keys(b.records[group])])) {
        const left = a.records[group][id], right = b.records[group][id];
        out.records[group][id] = !left ? right : !right ? left : compare(left, right) >= 0 ? left : right;
      }
    }
    return out;
  }
  function change(doc, before, after, device, now = Date.now()) {
    const out = merge(doc, empty());
    const stamp = [Math.max(now, maxClock(doc) + 1), device];
    const setDiff = (group, oldMap, newMap) => {
      for (const id of new Set([...Object.keys(oldMap), ...Object.keys(newMap)])) {
        if (!safeId(id) || equal(oldMap[id], newMap[id])) continue;
        const deleted = !Object.hasOwn(newMap, id);
        out.records[group][id] = deleted ? { stamp, deleted: true } : { stamp, deleted: false, value: newMap[id] };
      }
    };
    for (const key of KEYS) {
      if (!Object.hasOwn(after, key)) continue;
      setDiff(key, mapValues(key, before[key]), mapValues(key, after[key]));
      if (key === "laterOnProjects") {
        setDiff("projectSequence", { ids: (before[key] || []).map(p => p.id) }, { ids: (after[key] || []).map(p => p.id) });
      }
    }
    return out;
  }
  function seed(data, device) {
    // Existing local data on a new device fills gaps but cannot overwrite already synced records.
    const doc = change(empty(), {}, data, device, 0);
    for (const records of Object.values(doc.records)) for (const record of Object.values(records)) record.stamp = [0, device];
    return doc;
  }
  function activate(doc, device, now = Date.now()) {
    const out = merge(doc, empty());
    const stamp = [Math.max(now, maxClock(doc) + 1), device];
    for (const group of GROUPS) for (const [id, record] of Object.entries(out.records[group])) {
      if (record.stamp[0] === 0) out.records[group][id] = { ...record, stamp };
    }
    return out;
  }
  function materialize(doc) {
    const out = {};
    for (const key of KEYS) {
      const entries = Object.entries(doc.records[key]).filter(([, r]) => !r.deleted).map(([id, r]) => [id, r.value]);
      out[key] = key === "laterOnItems" || key === "laterOnProjects" ? entries.map(([, value]) => value) : Object.fromEntries(entries);
    }
    const projectIds = doc.records.projectSequence.ids?.value || [];
    const ranks = new Map(projectIds.map((id, i) => [id, i]));
    out.laterOnProjects.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || a.id.localeCompare(b.id));
    out.laterOnItems.sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0) || a.id.localeCompare(b.id));
    out.laterOnItems = out.laterOnItems.map(item => doc.records.laterOnProjects[item.projectId]?.deleted ? { ...item, projectId: null } : item);
    const ids = new Set(out.laterOnItems.map(item => item.id));
    for (const key of ["laterOnCovers", "laterOnReadingPositions"]) {
      out[key] = Object.fromEntries(Object.entries(out[key]).filter(([id]) => ids.has(id)));
    }
    out.laterOnOrder = Object.fromEntries(Object.entries(out.laterOnOrder).map(([key, list]) => [key, list.filter(id => ids.has(id))]));
    return out;
  }
  root.LaterOnSyncCore = { KEYS, empty, equal, validate, merge, change, seed, activate, materialize };
})(globalThis);

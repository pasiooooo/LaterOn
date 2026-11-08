// Compare the picker snapshot with actual batch saving when several tabs have
// the same Reading identity. Preserve all targets and their original URLs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const contextCode = background.slice(background.indexOf('function pickerSaveContext('), background.indexOf('async function showPickerOverlay('));
const batchCode = background.slice(background.indexOf('async function runBatchSave('), background.indexOf('// ── 网页内的「选择项目」浮层'));
const plain = value => JSON.parse(JSON.stringify(value));
async function run(items, tabs, english = false) {
  const data = { laterOnItems: plain(items) }, pills = [], extracted = [], diagnostics = [];
  const ctx = vm.createContext({ URL, Date, crypto, setTimeout, clearTimeout,
    STORAGE_KEY: 'laterOnItems', usesEnglish: async () => english,
    recordDiag: async patch => diagnostics.push(plain(patch)),
    notifyTab: async (_id, text, kind) => pills.push({ text, kind }),
    queueItemWrite: fn => fn(),
    // The actual save loop owns identity, writes, ordering and statistics;
    // this fixture supplies deterministic metadata and no host side effects.
    mergeDuplicateMetadata: (record, meta) => {
      if ((!record.description || record.description === '暂无摘要') && meta.description) { record.description = meta.description; return true; }
      return false;
    },
    isIncomplete: record => !record.description || record.description === '暂无摘要',
    pillTitle: title => title, safeHostname: url => new URL(url).hostname,
    showActionFeedback: async () => {}, showActionError: async () => {},
    extractTabMetadata: async tab => { extracted.push(tab.url); return { ...tab }; },
    chrome: { storage: { local: {
      get: async () => plain(data),
      set: async patch => Object.assign(data, plain(patch))
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'url-utils.js'), 'utf8'), ctx);
  vm.runInContext('const normalizeUrl=LaterOnUrl.normalize;\n' + contextCode + batchCode, ctx);
  const snapshot = plain(ctx.pickerSaveContext(tabs, items, [{ id: 'work', name: '工作' }, { id: 'other', name: '其他项目' }], english).saveContext);
  const outcome = plain(await ctx.runBatchSave({ tabs, projectId: 'other', projectName: '其他项目' }));
  assert.deepEqual(extracted, tabs.map(tab => tab.url), 'Every original target still receives metadata extraction');
  return { snapshot, outcome, pills, items: data.laterOnItems, diagnostics };
}
const saved = { id: 'saved', title: '已存网页', url: 'https://same.test/paper', projectId: 'work', description: '现有摘要' };
const oldTabs = [{ title: '已有1', url: 'https://www.same.test/paper?utm_source=one#first' },
  { title: '已有2', url: 'https://same.test/paper?utm_source=two#second' }];
const newTabs = [{ title: '新网页1', url: 'https://new.test/page?utm_source=one#first', description: '' },
  { title: '新网页2', url: 'https://www.new.test/page?utm_source=two#second', description: '后来抓到的摘要' }];
(async () => {
  let result = await run([saved], [...oldTabs, ...newTabs]);
  assert.equal(result.snapshot.total, 2);
  assert.equal(result.snapshot.newCount, 1);
  assert.equal(result.snapshot.savedCount, 1);
  assert.deepEqual({ added: result.outcome.added, duplicated: result.outcome.duplicated, moved: result.outcome.moved },
    { added: 1, duplicated: 1, moved: 1 });
  assert.equal(result.items.length, 2);
  assert(result.items.every(item => item.projectId === 'other'));
  assert.equal(result.items.find(item => item.id !== 'saved').url, newTabs[0].url, 'The saved original URL is never rewritten to its normalized identity');
  assert.equal(result.items.find(item => item.id !== 'saved').description, '后来抓到的摘要', 'Repeated tabs may still fill missing metadata');
  assert.equal(result.outcome.degraded, 0, 'Missing metadata is assessed from the final unique records');
  const summary = result.pills.find(pill => pill.text.startsWith('全部完成：'))?.text;
  assert(summary.includes('新增 1 篇') && summary.includes('1 篇已添加网页移入'));
  assert(!summary.includes('本来就在'), 'A duplicate of a page added in this batch is not described as an earlier save');
  assert.equal(result.pills.filter(pill => pill.text.startsWith('已添加过：')).length, 0);
  assert.equal(result.diagnostics.at(-1).lastDuplicated, 1);

  result = await run([{ ...saved, projectId: 'other' }], oldTabs);
  assert.equal(result.snapshot.sameProjectId, 'other');
  assert.equal(result.outcome.added, 0); assert.equal(result.outcome.duplicated, 1); assert.equal(result.outcome.moved, 0);
  assert.equal(result.items.length, 1);

  result = await run([], newTabs, true);
  assert.equal(result.snapshot.total, 1); assert.equal(result.outcome.added, 1); assert.equal(result.outcome.duplicated, 0);
  assert(result.pills.some(pill => pill.text === 'Done: 1 added'));
  assert(!result.pills.some(pill => pill.text.includes('already in')));
  result = await run([{ ...saved, projectId: 'other', description: '' }],
    [{ ...oldTabs[0], description: '' }, { ...oldTabs[1], description: '补全的摘要' }]);
  assert.equal(result.outcome.enriched, 1); assert.equal(result.outcome.degraded, 0);
  assert(result.pills.some(pill => pill.text === '全部完成：更新了 1 篇的信息'));
  console.log('PASS unique batch save statistics match immediate picker counts; duplicate tabs preserve raw URLs, extraction and metadata refresh without false existing membership');
})().catch(error => { console.error(error); process.exitCode = 1; });

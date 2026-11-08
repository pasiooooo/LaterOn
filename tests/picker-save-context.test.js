// Use the actual background picker snapshot, with synthetic native injection.
// No extra collection reads or project moves are performed just to display it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8');
const code = source.slice(source.indexOf('const PICKER_INJECT_TIMEOUT_MS ='), source.indexOf('// 新建项目（浮层和收藏库共用'));
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const data = { laterOnItems: [], laterOnProjects: [{ id: 'work', name: '工作' }, { id: 'other', name: '其他项目' },
    { id: 'archive', name: '归档资料', archived: true }], laterOnSettings: {}, laterOnCovers: {} };
  const reads = [], payloads = [], writes = [];
  const ctx = vm.createContext({ URL, setTimeout, clearTimeout,
    PROJECTS_KEY: 'laterOnProjects', STORAGE_KEY: 'laterOnItems', SETTINGS_KEY: 'laterOnSettings', COVERS_KEY: 'laterOnCovers',
    isWebUrl: value => /^https?:/.test(value || ''), withTimeout: promise => promise,
    chrome: { storage: { local: {
      async get(keys) { reads.push(keys); return Object.fromEntries(keys.map(key => [key, data[key]])); },
      async set(value) { writes.push(value); Object.assign(data, value); }
    } }, scripting: {
      async executeScript(options) {
        if (options.args?.length) payloads.push(plain(options.args[0]));
        return [{ result: true }];
      }
    } }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../url-utils.js'), 'utf8'), ctx);
  vm.runInContext('const normalizeUrl=LaterOnUrl.normalize;\n' + code, ctx);
  const show = async (tabs, extra = {}) => {
    const before = reads.length;
    assert.equal(await ctx.showPickerOverlay({ id: 99, url: 'https://source.test/' }, { tabs, savedCount: 999, ...extra }), true);
    assert.equal(reads.length - before, 1, 'Membership, counts and covers share one existing storage read');
    assert.equal(writes.length, 0, 'Displaying membership never updates items or pending batch state');
    return payloads.at(-1);
  };
  return { data, ctx, reads, writes, show };
}
const tab = (url, title = '网页') => ({ url, title });
const saved = (url, projectId, id = url) => ({ id, url, projectId, title: '已保存网页' });
(async () => {
  const f = fixture();
  f.data.laterOnItems = [saved('https://a.test/one', 'work'), saved('https://b.test/two', 'work')];
  let view = await f.show([tab('https://a.test/one'), tab('https://b.test/two')]);
  assert.equal(view.selected, 'work', 'Every target already in one project immediately selects that project');
  assert.deepEqual(view.saveContext, { total: 2, savedCount: 2, newCount: 0,
    groups: [{ projectId: 'work', projectName: '工作', count: 2 }], sameProjectId: 'work' });
  assert.equal(view.folders.find(folder => folder.id === 'work').matchedCount, 2);
  assert(view.pages.every(page => page.saved && page.projectName === '工作'));
  assert.equal((await f.show([tab('https://a.test/one')])).selected, 'work', 'Single existing saves use their real project too');

  view = await f.show([tab('https://a.test/one'), tab('https://new.test/three')]);
  assert.equal(view.selected, '', 'A mixed batch keeps the ordinary Inbox default');
  assert.equal(view.saveContext.newCount, 1); assert.equal(view.saveContext.savedCount, 1);
  assert.equal(view.saveContext.sameProjectId, null);
  assert.equal(view.pages[1].saved, false);
  assert(!('projectId' in view.pages[1]), 'New targets never acquire membership from the default selection');

  f.data.laterOnItems.push(saved('https://c.test/three', 'other'));
  view = await f.show([tab('https://a.test/one'), tab('https://c.test/three')]);
  assert.equal(view.selected, ''); assert.equal(view.saveContext.groups.length, 2);
  assert.equal(view.saveContext.newCount, 0); assert.equal(view.saveContext.sameProjectId, null);

  f.data.laterOnItems = [saved('https://a.test/one', null), saved('https://b.test/two', '')];
  view = await f.show([tab('https://a.test/one'), tab('https://b.test/two')]);
  assert.equal(view.selected, ''); assert.equal(view.saveContext.sameProjectId, '');
  assert.deepEqual(view.saveContext.groups, [{ projectId: '', projectName: '等待整理', count: 2 }]);

  f.data.laterOnItems = [saved('https://a.test/one', 'archive'), saved('https://b.test/two', 'deleted')];
  view = await f.show([tab('https://a.test/one')]);
  assert.equal(view.selected, '', 'Archived projects are not valid new destinations');
  assert.equal(view.saveContext.groups[0].projectId, 'archive'); assert.equal(view.saveContext.groups[0].archived, true);
  assert(view.pages[0].projectName.includes('已归档'));
  assert.equal(view.folders.find(folder => folder.id === '').matchedCount, 0, 'Archived records are never counted as already in Inbox');
  view = await f.show([tab('https://b.test/two')]);
  assert.equal(view.saveContext.groups[0].missing, true); assert.equal(view.pages[0].projectName, '已删除的项目');
  assert.equal(view.folders.find(folder => folder.id === '').matchedCount, 0);

  f.data.laterOnItems = [saved('https://www.same.test/paper?utm_source=old#one', 'work', 'first'),
    saved('https://same.test/paper', 'other', 'second')];
  const originals = [tab('https://same.test/paper?utm_source=new#two'), tab('https://www.same.test/paper#three')];
  view = await f.show(originals);
  assert.equal(view.selected, 'work'); assert.equal(view.saveContext.total, 1); assert.equal(view.saveContext.savedCount, 1);
  assert.equal(view.pages.length, 2, 'The batch tab list stays intact while membership counts unique save identities');
  assert(view.pages.every(page => page.projectId === 'work'), 'Membership matches the first existing record, just like saving');
  assert.deepEqual(view.pages.map(page => page.url), originals.map(page => page.url), 'Presentation never rewrites the actual target URLs');

  f.data.laterOnItems = [saved('https://x.test/1', 'work', 'cover-first'), saved('https://x.test/2', 'work', 'cover-later'),
    { ...saved('https://x.test/3', '', 'inbox'), image: 'local://inbox-cover' }];
  f.data.laterOnCovers = { 'cover-first': 'data:image/png;base64,first', 'cover-later': 'data:image/png;base64,later',
    'inbox-cover': 'data:image/png;base64,inbox' };
  view = await f.show([tab('https://new.test/page')]);
  assert.equal(view.selected, ''); assert.equal(view.folders.find(folder => folder.id === 'work').cover, 'data:image/png;base64,first');
  assert.equal(view.folders.find(folder => folder.id === '').cover, 'data:image/png;base64,inbox');
  f.data.laterOnProjects[0].cover = 'data:image/png;base64,custom';
  view = await f.show([tab('https://x.test/1')]);
  assert.equal(view.folders.find(folder => folder.id === 'work').cover, 'data:image/png;base64,custom', 'Custom project covers retain precedence');

  f.data.laterOnSettings.language = 'en';
  f.data.laterOnItems = [saved('https://a.test/one', 'archive'), saved('https://b.test/two', null)];
  view = await f.show([tab('https://a.test/one'), tab('https://b.test/two')]);
  assert.equal(view.language, 'en'); assert(view.pages[0].projectName.includes('(archived)')); assert.equal(view.pages[1].projectName, 'Inbox');
  console.log('PASS picker save context: immediate real project selection, mixed groups, normalized unique targets, first-record identity, archived/missing membership, covers, bilingual snapshot and one read without writes');
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
const diagnostic = source.slice(source.indexOf('const DIAG_KEY ='), source.indexOf('// ── 右键菜单'));
const command = source.slice(source.indexOf('chrome.commands.onCommand.addListener('), source.indexOf('async function handleCommand('));
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  let listener;
  const reads = [], actions = [], writes = [];
  let stored = { earlier: true };
  const context = vm.createContext({
    chrome: {
      commands: { onCommand: { addListener(fn) { listener = fn; } } },
      storage: { local: {
        get(key) { assert.equal(key, 'laterOnDiag'); return new Promise((resolve, reject) => reads.push({ resolve, reject })); },
        async set(patch) { stored = { ...patch.laterOnDiag }; writes.push(stored); }
      } }
    },
    async handleCommand(name, tab) { actions.push({ name, tab }); },
    async reportFailure(error) { throw error; }
  });
  vm.runInContext(diagnostic + command, context);
  const tab = { id: 11 };
  listener('quick-switcher', tab);
  listener('quick-save', tab);
  await tick();
  assert.deepEqual(actions.map(action => action.name), ['quick-switcher', 'quick-save'],
    'Both shortcuts start while diagnostic storage is still pending');
  assert.equal(actions[0].tab, tab);
  assert.equal(reads.length, 1, 'Diagnostic read/merge/write operations run one at a time');
  const stage = context.recordDiag({ lastStage: 'saved' });
  reads[0].resolve({ laterOnDiag: stored });
  await tick();
  assert.equal(reads.length, 2);
  reads[1].resolve({ laterOnDiag: stored });
  await tick();
  assert.equal(reads.length, 3);
  reads[2].resolve({ laterOnDiag: stored });
  await stage;
  assert.equal(writes.length, 3);
  assert.equal(stored.earlier, true);
  assert.equal(stored.lastCommand, 'quick-save');
  assert.equal(stored.lastStage, 'saved', 'A result record retains the command record');

  const failed = context.recordDiag({ failure: true });
  await tick();
  reads[3].reject(Error('storage unavailable'));
  await failed;
  const recovered = context.recordDiag({ recovered: true });
  await tick();
  reads[4].resolve({ laterOnDiag: stored });
  await recovered;
  assert.equal(stored.recovered, true, 'A failed diagnostic does not stop later records');

  const pickers = [], pickerReads = [];
  const picker = vm.createContext({
    chrome: { storage: { local: {
      get(key) {
        if (key === 'laterOnDiag') { pickerReads.push(key); return new Promise(() => {}); }
        if (key === 'laterOnSettings') return Promise.resolve({ laterOnSettings: { askFolderOnBatch: true } });
        if (key === 'laterOnItems') return Promise.resolve({ laterOnItems: [] });
        throw Error(`Unexpected startup read: ${key}`);
      }, async set() {}
    } } },
    async usesEnglish() { return false; }, async shouldAskFolderForSingle() { return true; },
    normalizeUrl: url => url, isWebUrl: url => /^https?:/.test(url),
    async askFolderThenSave(payload) { pickers.push(payload); return { ok: true }; },
    async runBatchSave() { throw Error('Picker should be enabled'); },
    async showActionError() { throw Error('A valid tab should not fail'); }
  });
  const single = source.slice(source.indexOf('async function quickSave('), source.indexOf('async function showActionError('));
  const batch = source.slice(source.indexOf('async function saveTabsInScope('), source.indexOf('async function shouldAskFolderForSingle('));
  vm.runInContext('const STORAGE_KEY="laterOnItems", SETTINGS_KEY="laterOnSettings", LAST_PROJECT_KEY="laterOnLastProject";\n' + diagnostic + single + batch, picker);
  picker.recordDiag({ lastCommand: 'quick-save' });
  await tick();
  const page = { id: 11, index: 0, url: 'https://page.test/' };
  const singleResult = picker.quickSave(page);
  const batchResult = picker.saveTabsInScope('shortcut', [page], page);
  await tick();
  assert.equal(pickers.length, 2, 'Single and batch project pickers appear while diagnostic storage is pending');
  assert.equal(pickerReads.length, 1, 'Progress records stay queued instead of gating the pickers');
  assert.equal(pickers[0].savedCount, 0);
  assert.equal(pickers[1].tabs[0], page);
  await Promise.all([singleResult, batchResult]);
  console.log('PASS shortcuts start before diagnostic storage; queued records preserve command/result fields and recover after failure');
})().catch(error => { console.error(error); process.exitCode = 1; });

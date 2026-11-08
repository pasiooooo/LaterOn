const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(test, message) {
  for (let n = 0; n < 100 && !test(); n++) await tick();
  assert(test(), message);
}
async function fixture(initial = { theme: 'dark', language: 'zh-CN', autoMarkRead: false }) {
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'settings.html'), 'utf8'), {
    url: 'chrome-extension://fixture/settings.html', runScripts: 'outside-only', virtualConsole: vc
  });
  const window = dom.window, callbacks = [], writes = [];
  let stored = clone(initial), failure = false, pending = null;
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.chrome = { storage: { local: {
    async get() { return { laterOnSettings: clone(stored) }; },
    async set(patch) {
      if (pending) await pending;
      if (failure) throw Error('Synthetic write failure');
      const before = stored; stored = clone(patch.laterOnSettings); writes.push(clone(stored));
      for (const callback of callbacks) callback({ laterOnSettings: { oldValue: before, newValue: clone(stored) } }, 'local');
    }
  }, onChanged: { addListener(callback) { callbacks.push(callback); } } } };
  for (const file of ['quick-switcher-modes.js', 'theme.js', 'i18n.js', 'quick-switcher-mode-settings.js']) {
    window.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
  await window.LaterOnI18n.ready;
  window.LaterOnQuickModeSettings.init(await window.LaterOnSettings.get());
  const form = window.document.querySelector('#quickModesForm');
  const row = index => form.querySelectorAll('.quick-mode-row')[index];
  const change = input => input.dispatchEvent(new window.Event('change', { bubbles: true }));
  return { dom, window, form, row, errors, writes,
    get state() { return clone(stored); },
    sources(index, sources) { for (const input of row(index).querySelectorAll('[data-source]')) input.checked = sources.includes(input.dataset.source); change(row(index).querySelector('[data-source]')); },
    prefix(index, type, value = '') {
      const select = row(index).querySelector('[data-prefix-type]'); select.value = type; change(select);
      if (type === 'custom') { const input = row(index).querySelector('[data-prefix-value]'); input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); }
    },
    submit() { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    fail(value) { failure = value; },
    pause() { let release; pending = new Promise(resolve => { release = resolve; }); return () => { pending = null; release(); }; },
    external(modes) {
      const before = stored; stored = { ...stored, quickSwitcherModes: clone(modes) };
      for (const callback of callbacks) callback({ laterOnSettings: { oldValue: before, newValue: clone(stored) } }, 'local');
    } };
}

(async () => {
  const current = await fixture();
  let persisted;
  try {
    assert.equal(current.form.querySelectorAll('.quick-mode-row').length, 4);
    assert.equal(current.form.querySelectorAll('[data-source]:checked').length, 6);
    assert.equal(current.form.querySelector('#quickModesSave').disabled, true);
    for (let bits = 1; bits < 8; bits++) {
      const sources = ['tabs', 'reading', 'bookmarks'].filter((_source, index) => bits & (1 << index));
      for (let slot = 0; slot < 4; slot++) {
        current.sources(slot, sources);
        const expectedWrites = current.writes.length + (current.form.querySelector('#quickModesSave').disabled ? 0 : 1);
        current.submit();
        await until(() => current.writes.length === expectedWrites && current.form.querySelector('#quickModesSave').disabled
          && !current.form.querySelector('#quickModesFeedback').textContent.includes('正在保存'), 'Each legal source combination is saved');
        assert.deepEqual(current.state.quickSwitcherModes[slot].sources, sources);
        assert.equal(current.state.theme, 'dark'); assert.equal(current.state.autoMarkRead, false);
      }
    }
    current.sources(0, []); current.submit(); await tick();
    assert.equal(current.form.querySelector('#quickModesSave').disabled, true);
    assert.match(current.form.querySelector('#quickModesFeedback').textContent, /至少选择/);
    assert.notDeepEqual(current.state.quickSwitcherModes[0].sources, []);
    current.sources(0, ['tabs']);
    current.prefix(3, 'space'); current.submit(); await tick();
    assert.match(current.form.querySelector('#quickModesFeedback').textContent, /重复或互为开头/);
    current.prefix(3, 'custom', 'r:');
    current.prefix(2, 'custom', 'r');
    assert.equal(current.form.querySelector('#quickModesSave').disabled, true, 'Overlapping multichar prefixes cannot be saved');
    current.prefix(2, 'custom', '/'); current.prefix(1, 'space');
    current.submit(); await until(() => !current.form.querySelector('#quickModesFeedback').textContent.includes('正在'), 'Custom prefixes save');
    assert.deepEqual(current.state.quickSwitcherModes.map(mode => mode.prefix), ['', ' ', '/', 'r:']);
    persisted = current.state;
    const changed = current.window.LaterOnQuickModes.normalize(); changed[3].prefix = '<';
    current.external(changed);
    assert.equal(current.row(3).querySelector('[data-prefix-value]').value, '<');
    assert.equal(current.row(3).querySelector('img'), null, 'Prefix values are plain text, never HTML');
    current.prefix(3, 'custom', '!');
    current.fail(true); current.submit();
    await until(() => current.form.querySelector('#quickModesFeedback').dataset.phase === 'error', 'Failed writes are reported');
    assert.equal(current.row(3).querySelector('[data-prefix-value]').value, '!');
    assert.equal(current.state.quickSwitcherModes[3].prefix, '<');
    current.fail(false);
    const other = current.window.LaterOnQuickModes.normalize(); other[3].prefix = '#';
    current.external(other);
    assert.equal(current.row(3).querySelector('[data-prefix-value]').value, '!', 'External changes preserve an unsaved draft');
    assert.match(current.form.querySelector('#quickModesFeedback').textContent, /其他页面/);
    const release = current.pause(); current.submit();
    current.prefix(3, 'custom', '?'); release();
    await until(() => current.state.quickSwitcherModes[3].prefix === '!' && !current.form.querySelector('#quickModesSave').disabled, 'Edits made during a save remain unsaved');
    assert.equal(current.row(3).querySelector('[data-prefix-value]').value, '?');
    assert.match(current.form.querySelector('#quickModesFeedback').textContent, /配置已修改/);
    current.form.querySelector('#quickModesReset').click();
    assert.equal(current.row(1).querySelector('[data-prefix-type]').value, 'tab');
    assert.equal(current.state.quickSwitcherModes[3].prefix, '!', 'Reset remains a draft until Save');
    current.submit(); await until(() => current.state.quickSwitcherModes[3].prefix === "'", 'Reset defaults can be saved');
    assert.deepEqual(current.errors, []);
  } finally { current.dom.window.close(); }
  const reopened = await fixture(persisted);
  try {
    assert.equal(reopened.row(1).querySelector('[data-prefix-type]').value, 'space');
    assert.equal(reopened.row(2).querySelector('[data-prefix-value]').value, '/');
    assert.equal(reopened.row(3).querySelector('[data-prefix-value]').value, 'r:');
    assert.deepEqual([...reopened.row(0).querySelectorAll('[data-source]:checked')].map(input => input.dataset.source), ['tabs']);
  } finally { reopened.dom.window.close(); }
  const english = await fixture({ ...persisted, language: 'en' });
  try {
    assert.equal(english.row(0).querySelector('legend').textContent, 'Default on opening');
    assert.match(english.row(0).textContent, /Open tabs \(all windows\)/);
    assert.equal(english.form.querySelector('#quickModesSave').textContent, 'Save modes');
  } finally { english.dom.window.close(); }
  const concurrent = await fixture();
  try {
    const release = concurrent.pause();
    concurrent.sources(0, ['tabs', 'reading']); concurrent.submit();
    const themeSave = concurrent.window.LaterOnSettings.set({ theme: 'light' });
    release(); await themeSave;
    await until(() => !concurrent.form.querySelector('#quickModesFeedback').textContent.includes('正在保存'), 'Concurrent local settings settle');
    assert.deepEqual(concurrent.state.quickSwitcherModes[0].sources, ['tabs', 'reading']);
    assert.equal(concurrent.state.theme, 'light', 'A concurrent theme edit cannot undo mode choices');
  } finally { concurrent.dom.window.close(); }
  console.log('PASS Quick Switcher mode settings: 7 combinations in every slot, custom/reassigned prefixes, validation, persistence, write failure, draft races and bilingual controls');
})().catch(error => { console.error(error); process.exitCode = 1; });

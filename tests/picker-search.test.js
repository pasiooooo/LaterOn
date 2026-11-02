const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.resolve(__dirname, '../picker-ui.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
(async () => {
  const dom = new JSDOM('<!doctype html><html><body><button id="anchor">Move</button></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.eval(source);
  const folders = [{ id: '', name: '等待整理' }, { id: 'work', name: 'Work Notes' }, { id: 'design', name: '设计灵感' }];
  const open = options => {
    const layer = window.openFolderPicker({ folders, selected: 'work', ...options });
    const shadow = window.document.querySelector('#lateron-folder-picker').shadowRoot;
    const input = shadow.querySelector('.lon-search-input'), button = shadow.querySelector('.lon-primary');
    assert(input);
    assert.equal(shadow.querySelectorAll('input').length, 1, 'Search and creation share one field');
    assert.equal(shadow.querySelector('.lon-new-input'), null, 'There is no separate bottom new-project input');
    assert.equal(shadow.activeElement, input);
    return { layer, shadow, input, button,
      filter(text) { input.value = text; input.dispatchEvent(new window.Event('input', { bubbles: true })); },
      key(key, extra = {}) { input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...extra })); },
      names() { return [...shadow.querySelectorAll('.lon-folder-name')].map(el => el.textContent); }
    };
  };
  try {
    for (const language of ['zh-CN', 'en']) for (const popover of [false, true]) {
      const options = { language, anchor: popover ? window.document.querySelector('#anchor') : null };
      const picked = [], created = [];
      let p = open({ ...options, onPick: id => { picked.push(id); }, onCreateProject: name => { created.push(name); return { id: 'new', name }; } });
      p.filter('  wOrK  '); assert.deepEqual(p.names(), ['Work Notes']);
      p.filter('work   notes'); assert.deepEqual(p.names(), ['Work Notes'], 'Match the same whitespace normalization as project creation');
      p.filter('设计'); assert.deepEqual(p.names(), ['设计灵感']);
      assert.equal(p.shadow.querySelector('.lon-folder').getAttribute('aria-checked'), 'true');
      p.filter('nothing matches');
      assert.deepEqual(p.names(), []);
      assert.equal(p.shadow.querySelector('.lon-empty').hidden, false);
      assert.equal(p.button.disabled, false);
      assert(p.button.textContent.includes('nothing matches'));
      assert.deepEqual(created, [], 'Typing a name never creates anything by itself');
      p.key('Enter', { isComposing: true }); p.key('Escape', { isComposing: true }); await tick();
      assert.deepEqual(picked, []); assert.deepEqual(created, []);
      assert(!p.shadow.querySelector('.lon-root').classList.contains('is-out'), 'IME confirmation/cancellation keeps the panel open');
      p.filter(''); assert.equal(p.names().length, 3);
      assert.equal(p.shadow.querySelector('.lon-empty').hidden, true);
      p.filter('work'); p.key('Enter'); await tick();
      assert.deepEqual(picked, ['work']); assert.deepEqual(created, []);
      p.layer.close();

      p = open({ ...options, onPick: id => { picked.push(id); }, onCreateProject: name => { created.push(name); return { id: 'new', name }; } });
      p.filter('x'.repeat(29));
      assert.equal(p.button.disabled, true, 'New project names are limited to 28 characters without silent truncation');
      assert(p.shadow.querySelector('.lon-empty').textContent.includes('28'));
      p.key('Enter'); await tick(); assert.deepEqual(created, []);
      p.filter('<b>new</b>'); assert.equal(p.shadow.querySelector('b'), null, 'New names are rendered as text');
      p.filter('  Novel   Notes  '); p.key('Enter'); await tick();
      assert.deepEqual(created, ['Novel Notes']); assert.deepEqual(picked, ['work', 'new']);
      assert(p.shadow.querySelector('.lon-root').classList.contains('is-out'));
      p.layer.close();

      let attempts = 0, picks = 0, release;
      p = open({ ...options,
        onCreateProject() { attempts++; return attempts === 1 ? null : new Promise(resolve => { release = resolve; }); },
        onPick() { picks++; return picks === 1 ? { ok: false, error: 'Save failed' } : { ok: true }; }
      });
      p.filter('Retry project'); p.button.click(); await tick();
      assert.equal(attempts, 1); assert.equal(picks, 0); assert.equal(p.input.value, 'Retry project');
      assert.equal(p.button.disabled, false, 'A failed create can be retried');
      p.button.click(); await tick();
      assert.equal(p.input.readOnly, true); assert.equal(p.button.disabled, true);
      p.key('Enter'); p.button.click(); assert.equal(attempts, 2, 'Busy submissions do not duplicate creates');
      release({ id: 'created', name: 'Retry project' }); await tick();
      assert.equal(picks, 1); assert.equal(p.button.disabled, false); assert.equal(p.input.readOnly, false);
      assert.equal(p.shadow.querySelector('.lon-folder[aria-checked="true"]').querySelector('.lon-folder-name').textContent, 'Retry project');
      p.button.click(); await tick();
      assert.equal(attempts, 2, 'A failed save reuses the project that was already created'); assert.equal(picks, 2);
      p.layer.close();
    }
    console.log('PASS unified picker: one field, normalized matching, explicit no-match creation, name bounds, safe text, IME, busy and failure retries in both languages/surfaces');
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

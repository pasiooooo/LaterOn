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
  try {
    for (const language of ['zh-CN', 'en']) {
      for (const popover of [false, true]) {
        const picked = [], created = [];
        const layer = window.openFolderPicker({ language, anchor: popover ? window.document.querySelector('#anchor') : null,
          selected: 'work', folders: [{ id: '', name: '等待整理' }, { id: 'work', name: 'Work Notes' }, { id: 'design', name: '设计灵感' }],
          onPick: id => { picked.push(id); }, onCreateProject: name => { created.push(name); return { id: 'new', name }; } });
        const shadow = window.document.querySelector('#lateron-folder-picker').shadowRoot;
        const input = shadow.querySelector('.lon-search-input');
        assert(input, 'Project picker exposes a search input');
        assert.equal(shadow.activeElement, input);
        const filter = text => { input.value = text; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
        const names = () => [...shadow.querySelectorAll('.lon-folder-name')].map(el => el.textContent);
        filter('  wOrK  ');
        assert.deepEqual(names(), ['Work Notes']);
        filter('设计');
        assert.deepEqual(names(), ['设计灵感']);
        assert.equal(shadow.querySelector('.lon-folder').getAttribute('aria-checked'), 'true');
        filter('nothing matches');
        assert.deepEqual(names(), []);
        assert.equal(shadow.querySelector('.lon-empty').hidden, false);
        assert.equal(shadow.querySelector('.lon-primary').disabled, true);
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
        await tick();
        assert.deepEqual(picked, [], 'No matches cannot submit an invisible project');
        filter('设计');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, composed: true }));
        await tick();
        assert.deepEqual(picked, [], 'IME confirmation does not submit');
        filter('');
        assert.equal(names().length, 3);
        assert.equal(shadow.querySelector('.lon-empty').hidden, true);
        assert.equal(shadow.querySelector('.lon-new-input').value, '', 'Searching never creates a project');
        filter('work');
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
        await tick();
        assert.deepEqual(picked, ['work']);
        assert.deepEqual(created, []);
        layer.close();
      }
    }
    console.log('PASS picker search: modal/popover, languages, text matching, empty state, keyboard, IME and no accidental creation');
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

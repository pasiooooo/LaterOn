const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

(async () => {
  const dom = new JSDOM('<!doctype html><html><body><input id="page-search"><button id="anchor">Move</button></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom, document = window.document;
  // Match document_start: the gate precedes page listeners; the UI is injected later.
  if (fs.existsSync(path.join(root, 'picker-keyboard-guard.js'))) window.eval(read('picker-keyboard-guard.js'));
  const seen = [], picked = [];
  for (const target of [window, document]) for (const capture of [true, false]) for (const type of ['keydown', 'keypress', 'keyup']) {
    target.addEventListener(type, event => {
      seen.push(`${type}:${event.key}`);
      if (type === 'keydown' && event.key.toLowerCase() === 's') document.querySelector('#page-search').focus();
    }, capture);
  }
  window.eval(read('picker-ui.js'));
  const options = { selected: 'science', folders: [{ id: 'science', name: 'Science' }], onPick: id => { picked.push(id); } };
  const key = (target, type, name, extra = {}) => {
    const event = new window.KeyboardEvent(type, { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, bubbles: true, composed: true, cancelable: true, ...extra });
    target.dispatchEvent(event); return event;
  };
  const shadow = () => document.querySelector('#lateron-folder-picker').shadowRoot;
  try {
    document.querySelector('#page-search').focus();
    const first = window.openFolderPicker(options);
    const gate = window.LaterOnPickerKeyboard;
    window.eval(read('picker-keyboard-guard.js'));
    assert.equal(window.LaterOnPickerKeyboard, gate, 'Fallback reinjection does not stack early listeners');
    let input = shadow().querySelector('.lon-search-input');
    for (const type of ['keydown', 'keypress', 'keyup']) assert.equal(key(input, type, 's').defaultPrevented, false, 'Native typing remains enabled');
    assert.equal(shadow().activeElement, input, 'A page capture shortcut must not steal focus from the picker');
    assert.deepEqual(seen, [], 'Window/document capture and bubble handlers cannot see modal keys');
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      assert.equal(key(input, 'keydown', 's', extra).defaultPrevented, false);
      key(input, 'keyup', 's', extra);
    }
    assert.deepEqual(seen, [], 'Modified keys and IME events stay inside the modal');
    key(input, 'keydown', 'Enter', { isComposing: true });
    key(input, 'keydown', 'Escape', { isComposing: true });
    await tick();
    assert.equal(picked.length, 0);
    assert(shadow(), 'IME Escape cancels composition, not the picker');
    key(input, 'keydown', 'Tab', { shiftKey: true });
    assert.equal(shadow().activeElement, shadow().querySelector('.lon-primary'), 'Shift+Tab wraps inside the modal');
    key(shadow().activeElement, 'keydown', 'Tab');
    assert.equal(shadow().activeElement, input);
    key(input, 'keydown', 'ArrowDown');
    assert.equal(shadow().activeElement, shadow().querySelector('.lon-folder'));
    input.focus();
    key(input, 'keydown', 'Enter');
    await tick();
    assert.deepEqual(picked, ['science'], 'Enter still confirms the selected project');
    assert.equal(document.activeElement, document.querySelector('#page-search'), 'Closing restores the previous page focus');
    assert.equal(key(document.activeElement, 'keydown', 'Enter', { repeat: true }).defaultPrevented, true, 'A held closing key cannot activate the background page');
    key(input, 'keyup', 'Enter');
    assert.deepEqual(seen, [], 'The closing keyup must not leak into page shortcuts');
    key(document.querySelector('#page-search'), 'keydown', 's');
    assert(seen.length > 0, 'Page keyboard shortcuts resume after confirming');
    seen.length = 0;

    const previous = window.openFolderPicker(options);
    window.eval(read('picker-ui.js'));
    const current = window.openFolderPicker(options);
    previous.close();
    input = shadow().querySelector('.lon-new-input'); input.focus();
    key(input, 'keydown', 's'); key(input, 'keyup', 's');
    assert.deepEqual(seen, [], 'Reinjection replaces the old owner without releasing the new gate');
    key(input, 'keydown', 'Escape'); await tick(); key(input, 'keyup', 'Escape');
    assert.deepEqual(seen, []);
    key(document.querySelector('#page-search'), 'keydown', 's');
    assert(seen.length > 0, 'Page shortcuts resume after cancelling');
    current.close(); first.close();

    const removed = window.openFolderPicker(options);
    document.querySelector('#lateron-folder-picker').remove(); seen.length = 0;
    key(document.querySelector('#page-search'), 'keydown', 's');
    assert(seen.length > 0, 'Removing the modal cannot leave a keyboard lock behind');
    removed.close();
    window.openFolderPicker({ ...options, anchor: document.querySelector('#anchor') }); seen.length = 0;
    key(document.querySelector('#page-search'), 'keydown', 's');
    assert(seen.length > 0, 'A nonmodal project popover does not lock the rest of the page');

    const manifest = JSON.parse(read('manifest.json'));
    assert(manifest.content_scripts.some(script => script.run_at === 'document_start' && script.js.includes('picker-keyboard-guard.js')));
    assert(read('background.js').includes('"picker-keyboard-guard.js", "picker-ui.js", "content-folder-picker.js"'), 'Existing tabs also receive a fallback gate before the modal');
    console.log('PASS picker keyboard: early capture isolation, native editing, modifiers/IME, modal Tab navigation, closing keyup, reinjection and cleanup');
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

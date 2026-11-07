const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');
const begin = source.indexOf('saveButton.addEventListener("click", async () => {');
const end = source.indexOf('document.querySelector("#openLibrary")', begin);

(async () => {
  let handler, finish;
  const messages = [], labels = [];
  const response = new Promise(resolve => { finish = resolve; });
  const context = vm.createContext({
    currentItem: { url: 'https://clicked.test/' }, currentItemId: null, currentTabId: 7,
    saveButton: { disabled: false, addEventListener(name, callback) { handler = callback; } }, status: { textContent: '' },
    syncSaveButtonState(value) { labels.push(value); }, tr: value => value,
    chrome: { runtime: { sendMessage(message) { messages.push(message); return response; } } }
  });
  vm.runInContext(source.slice(begin, end), context);
  const saved = handler();
  assert.equal(messages[0].tabId, 7, 'The save request targets the page shown when Add was clicked');
  context.currentTabId = 8;
  context.currentItem = { url: 'https://next.test/' };
  finish({ ok: true });
  await saved;
  assert.deepEqual(labels, [], 'A delayed save response cannot mark the next active page as saved');
  console.log('PASS Reading save: click-time tab identity is retained and a late response cannot label the next tab as saved');
})().catch(error => { console.error(error); process.exitCode = 1; });

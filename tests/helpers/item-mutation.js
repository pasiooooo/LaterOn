// Run the real backend mutation code behind browser mocks used by DOM tests.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../../background.js'), 'utf8');
const mutation = source.slice(source.indexOf('async function mutateItems('), source.indexOf('async function usesEnglish()'));
const normalize = source.slice(source.indexOf('function normalizeCleanDays('), source.indexOf('function isDoneItem('));
module.exports = function install(window) {
  if (!window.chrome?.runtime || window.__itemMutationMock) return;
  window.__itemMutationMock = true;
  const context = vm.createContext({ chrome: window.chrome, Date, Set,
    STORAGE_KEY: 'laterOnItems', COVERS_KEY: 'laterOnCovers', ORDER_KEY: 'laterOnOrder', CURRENT_ITEM_KEY: 'laterOnCurrentItem', SETTINGS_KEY: 'laterOnSettings' });
  vm.runInContext(`let queue = Promise.resolve(); function queueItemWrite(task) { const result = queue.then(task); queue = result.catch(() => {}); return result; }\n${normalize}\n${mutation}`, context);
  const original = window.chrome.runtime.sendMessage;
  window.chrome.runtime.sendMessage = async function(message, ...args) {
    if (message?.type !== 'MUTATE_ITEMS') return original?.call(this, message, ...args);
    try { return await context.mutateItems(message); }
    catch (error) { return { ok: false, error: error.message }; }
  };
};

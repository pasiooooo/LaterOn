const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const read = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const waitFor = async (check, message) => {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert(check(), message);
};
const result = (id, extra = {}) => ({ id, url: `https://example.test/${id}`, title: `Article ${id}`, source: 'example.test',
  readingIds: [id], bookmarkIds: [], projectNames: ['博士研究'], folderNames: [], ...extra });
function fixture() {
  const errors = [], seen = [], vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><input id="site-search"><button id="anchor">Anchor</button></body></html>', {
    url: 'https://site.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc
  });
  const w = dom.window;
  w.chrome = { runtime: { getURL: file => `chrome-extension://fixture/${file}` } };
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  w.eval(read('picker-keyboard-guard.js'));
  // jsdom cannot create trusted DOM input. Keep the real early gate for page
  // propagation checks, and deliver trusted keyboard facades only from this
  // test-owned adapter to the callback registered by the UI.
  let keyboard = null;
  const capture = w.LaterOnPickerKeyboard.capture;
  w.LaterOnPickerKeyboard.capture = (handle, active) => { keyboard = handle; return capture(handle, active); };
  for (const target of [w, w.document]) for (const type of ['keydown', 'keypress', 'keyup']) target.addEventListener(type, event => seen.push(`${type}:${event.key}`), true);
  w.eval(read('quick-switcher-modes.js')); w.eval(read('quick-switcher-ui.js'));
  const open = options => w.LaterOnQuickSwitcherUI.open({ language: 'en', theme: 'light', styles: { theme: read('theme-vars.css'), component: read('quick-switcher.css') }, ...options });
  const key = (node, name, extra = {}) => {
    const event = new w.KeyboardEvent('keydown', { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, bubbles: true, composed: true, cancelable: true, ...extra });
    node.dispatchEvent(event);
    keyboard?.({ type: 'keydown', key: name, code: event.code, isTrusted: true, keyCode: extra.keyCode || 0, ...extra, preventDefault() { event.preventDefault(); } });
    return event;
  };
  return { dom, w, open, key, errors, seen };
}

(async () => {
  const f = fixture();
  try {
    const original = f.w.document.querySelector('#site-search'); original.focus();
    const opened = [], closed = [];
    const api = f.open({ search: async () => ({ results: [result('one', { tabIds: [1] }), result('two', { tabIds: [2], bookmarkIds: ['native-2'], folderNames: ['理论基础 / 方法'], title: '<img src=x onerror=alert(1)> & research' })], total: 2 }),
      onOpen: async (...args) => { opened.push(args); }, onClose: () => closed.push(true) });
    const s = api.shadow, input = s.querySelector('input');
    await waitFor(() => s.querySelectorAll('[role="option"]').length === 2, 'Initial recent results render');
    assert.equal(f.w.document.activeElement, api.host);
    assert.equal(api.host.shadowRoot, null, 'The host webpage cannot inspect private search results or input');
    assert.equal(s.activeElement, input, 'Typing starts in the query input');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-activedescendant'), s.querySelector('[aria-selected="true"]').id);
    assert.equal(s.querySelectorAll('img').length, 2, 'Only the returned result slice requests cached favicons');
    assert([...s.querySelectorAll('img')].every(image => image.src.startsWith('chrome-extension://fixture/_favicon/?pageUrl=')), 'Icons use the extension cached favicon endpoint');
    assert.equal(s.querySelectorAll('.qs-badge-reading').length, 2);
    assert.equal(s.querySelectorAll('.qs-badge-bookmark').length, 1, 'A duplicate has both membership labels');
    assert.equal(s.querySelectorAll('.qs-result-title')[1].textContent, '<img src=x onerror=alert(1)> & research', 'Untrusted title remains text');
    assert(s.querySelector('style').textContent.includes(':host([data-theme="dark"])'), 'Formal theme selectors are adapted to Shadow DOM');
    api.host.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, composed: true, cancelable: true }));
    await tick(); assert.equal(opened.length, 0, 'An untrusted page-generated Enter cannot activate a search result');
    f.key(input, 's');
    assert.deepEqual(f.seen, [], 'Early keyboard ownership isolates page capture handlers');
    assert.equal(f.key(input, 'ArrowDown').defaultPrevented, true);
    assert.equal(s.querySelector('[aria-selected="true"]').id, 'lateron-switcher-option-1');
    f.key(input, 'Tab'); assert.equal(api.modeId, 'mode1'); assert.equal(s.activeElement, input, 'Unmodified Tab selects the configured mode without moving typing focus');
    await waitFor(() => s.querySelectorAll('.qs-result').length === 2, 'Live tabs render in the selected mode');
    assert.equal(s.querySelectorAll('.qs-badge-reading').length, 0, 'Excluded source badges are hidden');
    s.querySelector('[data-mode-id="default"]').click();
    await waitFor(() => s.querySelectorAll('.qs-badge-reading').length === 2, 'Visible mode control restores All');
    f.key(input, 'ArrowDown');
    f.key(input, 'Tab', { shiftKey: true }); assert.equal(s.activeElement, s.querySelector('[data-mode-id="mode3"]'), 'Shift+Tab retains normal modal focus navigation');
    input.focus();
    f.key(input, 'Enter', { isComposing: true }); f.key(input, 'Escape', { keyCode: 229 });
    await tick(); assert.equal(opened.length, 0); assert.equal(api.host.isConnected, true, 'IME Enter/Escape never submit or dismiss');
    f.key(input, 'Enter', { ctrlKey: true });
    await waitFor(() => !api.host.isConnected, 'Successful activation closes the switcher');
    assert.equal(opened[0][0].id, 'two'); assert.equal(opened[0][1].newTab, true);
    assert.equal(f.w.document.activeElement, original, 'Closing restores page focus');
    assert.equal(closed.length, 1);
    assert.equal(f.w.LaterOnQuickSwitcherUI.active, null);
    assert.deepEqual(f.errors, []);
  } finally { f.w.close(); }

  const race = fixture();
  try {
    const pending = [];
    const api = race.open({ language: 'zh-CN', theme: 'dark', search: query => new Promise((resolve, reject) => pending.push({ query, resolve, reject })), onOpen: async () => {} });
    const s = api.shadow, input = s.querySelector('input');
    assert.equal(api.host.dataset.theme, 'dark');
    assert(s.querySelector('.qs-status').textContent.includes('正在搜索'));
    input.value = 'old'; input.dispatchEvent(new race.w.Event('input'));
    await waitFor(() => pending.some(job => job.query === 'old'), 'First typed query dispatched');
    input.value = 'new'; input.dispatchEvent(new race.w.Event('input'));
    await waitFor(() => pending.some(job => job.query === 'new'), 'New typed query dispatched');
    pending.find(job => job.query === 'new').resolve({ results: [result('new')], total: 1 });
    await waitFor(() => s.querySelector('.qs-result-title')?.textContent === 'Article new', 'Latest search wins');
    pending.find(job => job.query === 'old').resolve({ results: [result('old')], total: 1 }); pending[0].resolve({ results: [result('initial')], total: 1 });
    await tick(); assert.equal(s.querySelector('.qs-result-title').textContent, 'Article new', 'Late results cannot replace a newer query');
    input.value = 'missing'; input.dispatchEvent(new race.w.Event('input'));
    await waitFor(() => pending.some(job => job.query === 'missing'), 'Empty query dispatched');
    pending.find(job => job.query === 'missing').resolve({ results: [], total: 0 });
    await waitFor(() => s.querySelector('.qs-status').textContent.includes('没有匹配'), 'No-match message is shown');
    assert.equal(input.hasAttribute('aria-activedescendant'), false);
    input.value = 'error'; input.dispatchEvent(new race.w.Event('input'));
    await waitFor(() => pending.some(job => job.query === 'error'), 'Failing query dispatched');
    pending.find(job => job.query === 'error').reject(new Error('offline'));
    await waitFor(() => !!s.querySelector('.qs-retry'), 'Search failure exposes retry');
    s.querySelector('.qs-retry').click();
    assert.equal(pending.filter(job => job.query === 'error').length, 2, 'Retry preserves the query');
    api.close(); pending.at(-1).resolve({ results: [result('late')], total: 1 }); await tick();
    assert.equal(race.w.document.querySelector('#lateron-quick-switcher'), null);
    assert.deepEqual(race.errors, []);
  } finally { race.w.close(); }

  const immediate = fixture();
  try {
    const pending = [], opened = [];
    const api = immediate.open({ search: query => query ? new Promise(resolve => pending.push({ query, resolve })) : Promise.resolve({ results: [result('old')], total: 1 }),
      onOpen: async selected => { opened.push(selected.id); } });
    const s = api.shadow, input = s.querySelector('input');
    await waitFor(() => s.querySelector('.qs-result-title')?.textContent === 'Article old', 'Previous query has visible results');
    input.value = 'new'; input.dispatchEvent(new immediate.w.Event('input'));
    immediate.key(input, 'Enter');
    assert.equal(pending.length, 1, 'Enter flushes the pending query before the debounce timer');
    assert.equal(pending[0].query, 'new'); assert.deepEqual(opened, [], 'Enter never activates the old visible result');
    pending[0].resolve({ results: [result('new', { url: 'https://example.test/docs/new?q=research#section' })], total: 1 });
    await waitFor(() => opened.length === 1, 'Current query can activate once its own search finishes');
    assert.deepEqual(opened, ['new']);
    const inspect = immediate.open({ search: async () => ({ results: [result('one', { url: 'https://example.test/docs/one#first' }), result('two', { url: 'https://example.test/docs/two#second' })], total: 2 }), onOpen: async () => {} });
    await waitFor(() => inspect.shadow.querySelectorAll('.qs-source').length === 2, 'Address results render');
    assert.equal(inspect.shadow.querySelectorAll('.qs-source')[0].textContent, 'example.test/docs/one#first');
    assert.equal(inspect.shadow.querySelectorAll('.qs-source')[1].title, 'https://example.test/docs/two#second', 'Same-domain pages have distinct paths and complete URL tooltips');
    inspect.close();
  } finally { immediate.w.close(); }

  const resize = fixture();
  try {
    const scheduled = new Map(), cancelled = [], scrolled = [], pageScrolls = [];
    let nextFrame = 0;
    resize.w.requestAnimationFrame = callback => { const id = ++nextFrame; scheduled.set(id, callback); return id; };
    resize.w.cancelAnimationFrame = id => { cancelled.push(id); scheduled.delete(id); };
    resize.w.Element.prototype.scrollIntoView = function (options) { scrolled.push({ element: this, options }); };
    resize.w.scrollTo = (...args) => pageScrolls.push(args);
    const api = resize.open({ search: async () => ({ results: Array.from({ length: 20 }, (_, i) => result(String(i))), total: 20 }), onOpen: async () => {} });
    await waitFor(() => api.shadow.querySelectorAll('.qs-result').length === 20, 'Scrollable result list becomes ready');
    const input = api.shadow.querySelector('input');
    for (let i = 0; i < 8; i++) resize.key(input, 'ArrowDown');
    assert.equal(scrolled.length, 8, 'Every keyboard selection keeps the active row visible');
    assert.equal(scrolled.at(-1).element.id, 'lateron-switcher-option-8');
    assert.deepEqual({ ...scrolled.at(-1).options }, { block: 'nearest', inline: 'nearest', behavior: 'instant', container: 'nearest' }, 'Selection scrolls immediately within the nearest result scrollport');
    for (let i = 0; i < 3; i++) resize.w.dispatchEvent(new resize.w.Event('resize'));
    assert.equal(scheduled.size, 1, 'Rapid resize events coalesce into one animation frame');
    assert.equal(scrolled.length, 8, 'Resize does not scroll before the new layout frame');
    const [frameId, callback] = scheduled.entries().next().value;
    scheduled.delete(frameId); callback();
    assert.equal(scrolled.length, 9);
    assert.equal(scrolled.at(-1).element.id, 'lateron-switcher-option-8', 'A narrowed viewport brings the same selected row back into view');
    resize.w.dispatchEvent(new resize.w.Event('resize'));
    const [pendingId, lateCallback] = scheduled.entries().next().value;
    api.close();
    assert(cancelled.includes(pendingId), 'Closing cancels the pending layout frame');
    assert.equal(scheduled.size, 0);
    lateCallback();
    resize.w.dispatchEvent(new resize.w.Event('resize'));
    assert.equal(scrolled.length, 9, 'Neither a late frame nor subsequent resizes can act on a closed switcher');
    assert.equal(scheduled.size, 0, 'Closing removes the resize listener');
    assert.deepEqual(pageScrolls, [], 'The component never scrolls the background document');
    assert.deepEqual(resize.errors, []);
  } finally { resize.w.close(); }

  const provisional = fixture();
  try {
    let pending = true, empty = false;
    const api = provisional.open({ search: async () => ({ results: empty ? [] : [result('available')], total: pending ? 9999 : 1, provisional: pending }), onOpen: async () => {} });
    const s = api.shadow;
    await waitFor(() => s.querySelectorAll('.qs-result').length === 1, 'Provisional results remain usable');
    assert(s.querySelector('.qs-count').textContent.includes('1 available'));
    assert(!s.querySelector('.qs-count').textContent.includes('9999'), 'An incomplete result set does not claim an exact library count');
    pending = false; api.refresh();
    await waitFor(() => s.querySelector('.qs-count').textContent === '1 pages', 'Fresh results restore the exact count');
    pending = true; empty = true; api.refresh();
    await waitFor(() => s.querySelector('.qs-status').textContent.includes('Searching your library'), 'An incomplete empty response is still loading');
    assert(!s.querySelector('.qs-status').textContent.includes('saved pages will appear'), 'Loading is not falsely reported as an empty collection');
    api.close();
    assert.deepEqual(provisional.errors, []);
  } finally { provisional.w.close(); }

  const failure = fixture();
  try {
    let attempts = 0;
    const api = failure.open({ search: async () => ({ results: [result('first'), result('second')], total: 200 }), onOpen: async () => { if (!attempts++) throw new Error('open'); } });
    const s = api.shadow, input = s.querySelector('input');
    await waitFor(() => s.querySelectorAll('.qs-result').length === 2, 'Results ready');
    assert.equal(s.querySelector('.qs-count').textContent, '2 of 200');
    failure.key(input, 'ArrowDown'); failure.key(input, 'Enter');
    await waitFor(() => s.querySelector('.qs-open-error'), 'Open failure remains actionable');
    assert(api.host.isConnected); assert.equal(input.readOnly, false); assert.equal(s.querySelector('[aria-selected="true"]').id, 'lateron-switcher-option-1');
    failure.key(input, 'Enter'); await waitFor(() => !api.host.isConnected, 'Retry can complete without losing the selection');
    const first = failure.open({ search: async () => ({ results: [], total: 0 }), onOpen: async () => {} });
    failure.w.eval(read('quick-switcher-ui.js'));
    const second = failure.open({ search: async () => ({ results: [], total: 0 }), onOpen: async () => {} });
    first.close(); assert(second.host.isConnected, 'Closing an obsolete handle cannot remove the replacement');
    assert.equal(failure.w.document.querySelectorAll('#lateron-quick-switcher').length, 1, 'Reinjection never stacks dialogs');
    await tick();
    assert(second.shadow.querySelector('.qs-status').textContent.includes('saved pages will appear'));
    failure.key(second.shadow.querySelector('input'), 'Escape'); assert.equal(failure.w.LaterOnQuickSwitcherUI.active, null);
    assert.deepEqual(failure.errors, []);
  } finally { failure.w.close(); }
  const modes = fixture();
  try {
    const searched = [];
    const dual = result('both', { tabIds: [7], bookmarkIds: ['bm7'], projectNames: ['Project'], folderNames: ['Folder'] });
    const api = modes.open({ search: async (query, context) => { searched.push({ query, ...context }); return { results: [dual], total: 1 }; }, onOpen: async () => {} });
    const s = api.shadow, input = s.querySelector('input');
    await waitFor(() => searched.length === 1 && s.querySelector('.qs-result'), 'All starts with a usable result');
    assert.equal(api.modeId, 'default'); assert.equal(s.querySelectorAll('.qs-mode').length, 4);
    assert.deepEqual(Array.from(searched[0].sources), ['tabs', 'reading', 'bookmarks']);
    input.value = ' two words'; input.dispatchEvent(new modes.w.Event('input'));
    await waitFor(() => searched.at(-1).query === 'two words', 'Leading space chooses Reading and preserves the following query');
    assert.equal(api.modeId, 'mode2'); assert.equal(input.value, 'two words');
    assert.equal(s.querySelectorAll('.qs-badge-reading').length, 1); assert.equal(s.querySelectorAll('.qs-badge-tabs, .qs-badge-bookmark').length, 0);
    assert.equal(s.querySelector('.qs-context').textContent, 'Project', 'Other-source contexts do not leak into the selected scope');
    input.value = 'two words more'; input.dispatchEvent(new modes.w.Event('input'));
    await waitFor(() => searched.at(-1).query === 'two words more', 'Ordinary multiword spaces remain search text');
    assert.equal(api.modeId, 'mode2');
    input.value = "' folder space"; input.dispatchEvent(new modes.w.Event('input'));
    await waitFor(() => searched.at(-1).query === 'folder space' && s.querySelector('.qs-badge-bookmark'), 'Pasted leading apostrophe chooses Bookmarks');
    assert.equal(api.modeId, 'mode3'); assert.equal(s.querySelector('.qs-context').textContent, 'Folder');
    input.value += ' more'; input.dispatchEvent(new modes.w.Event('input'));
    await waitFor(() => searched.at(-1).query === 'folder space more', 'A query separator after a pasted trigger cannot switch again on the next keystroke');
    assert.equal(api.modeId, 'mode3');
    input.value = ''; input.dispatchEvent(new modes.w.Event('input')); modes.key(input, 'Backspace');
    assert.equal(api.modeId, 'default', 'Backspace in an empty query returns to the default mode');
    input.value = 'kept query'; modes.key(input, 'Tab');
    assert.equal(api.modeId, 'mode1'); assert.equal(input.value, 'kept query'); assert.equal(s.activeElement, input);
    const custom = modes.w.LaterOnQuickModes.normalize(); custom[1].prefix = '@'; custom[2].prefix = ':r'; custom[3].prefix = ':b';
    input.value = ':b late query'; api.setModes(custom);
    await waitFor(() => searched.at(-1).query === ':b late query' && searched.at(-1).modeId === 'mode1' && s.querySelector('.qs-badge-tabs'), 'Configuration updates preserve the current slot and query even when a new prefix matches');
    assert.equal(api.modeId, 'mode1'); assert.equal(input.value, ':b late query');
    input.dispatchEvent(new modes.w.Event('input'));
    await waitFor(() => searched.at(-1).query === 'late query' && s.querySelector('.qs-badge-bookmark'), 'User input can interpret the newly configured prefix');
    assert.equal(api.modeId, 'mode3'); assert.equal(input.value, 'late query');
    const combinations = [['tabs'], ['reading'], ['bookmarks'], ['tabs', 'reading'], ['tabs', 'bookmarks'], ['reading', 'bookmarks'], ['tabs', 'reading', 'bookmarks']];
    s.querySelector('[data-mode-id="mode1"]').click();
    for (const sources of combinations) {
      const next = modes.w.LaterOnQuickModes.normalize(custom); next[1].sources = sources; api.setModes(next);
      await waitFor(() => JSON.stringify(Array.from(searched.at(-1).sources)) === JSON.stringify(sources) && s.querySelectorAll('.qs-badge').length === sources.length, 'Each nonempty source combination reaches search and controls its badges');
      assert.equal(api.modeId, 'mode1'); assert.equal(input.value, 'late query');
    }
    input.value = 'research'; input.dispatchEvent(new modes.w.Event('input'));
    await waitFor(() => searched.at(-1).query === 'research', 'An ordinary query is active before settings change');
    const matchingPrefix = modes.w.LaterOnQuickModes.normalize(custom); matchingPrefix[3].prefix = 'r'; matchingPrefix[1].sources = ['reading'];
    api.setModes(matchingPrefix);
    assert.equal(api.modeId, 'mode1'); assert.equal(input.value, 'research', 'A new r trigger cannot truncate research or move it to Bookmarks');
    await waitFor(() => searched.at(-1).query === 'research' && searched.at(-1).modeId === 'mode1' && searched.at(-1).sources.join(',') === 'reading' && s.querySelector('.qs-badge-reading'), 'Configuration refresh searches the preserved slot with its updated sources');
    api.close(); const reopened = modes.open({ modes: custom, search: async () => ({ results: [], total: 0 }), onOpen: async () => {} });
    assert.equal(reopened.modeId, 'default', 'Every invocation starts in its configured default slot'); reopened.close();
  } finally { modes.w.close(); }

  const composition = fixture();
  try {
    const searches = [];
    const api = composition.open({ search: async (query, context) => { searches.push({ query, ...context }); return { results: [], total: 0 }; }, onOpen: async () => {} });
    const input = api.shadow.querySelector('input'); await tick();
    input.dispatchEvent(new composition.w.CompositionEvent('compositionstart'));
    input.value = "'中文 两词"; input.dispatchEvent(new composition.w.InputEvent('input', { isComposing: true }));
    composition.key(input, 'Tab'); await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(api.modeId, 'default'); assert.equal(searches.length, 1, 'Composition neither changes mode nor starts partial searches');
    input.dispatchEvent(new composition.w.CompositionEvent('compositionend'));
    await waitFor(() => searches.length > 1, 'Completed composition can search');
    assert.equal(api.modeId, 'mode3'); assert.equal(input.value, '中文 两词'); assert.equal(searches.at(-1).query, '中文 两词');
    api.close();
  } finally { composition.w.close(); }

  const modeRace = fixture();
  try {
    const jobs = [], opened = [];
    const api = modeRace.open({ search: (query, context) => new Promise(resolve => jobs.push({ query, ...context, resolve })), onOpen: async (row, context) => { opened.push({ row, ...context }); } });
    jobs[0].resolve({ results: [result('old')], total: 1 });
    await waitFor(() => api.shadow.querySelector('.qs-result'), 'Previous mode result is visible');
    const input = api.shadow.querySelector('input'); input.value = 'same'; input.dispatchEvent(new modeRace.w.Event('input')); modeRace.key(input, 'Enter');
    assert.equal(jobs.length, 2); modeRace.key(input, 'Tab'); assert.equal(jobs.length, 3);
    assert.equal(api.shadow.querySelectorAll('.qs-result').length, 0, 'Switching mode immediately clears old actionable rows');
    jobs[1].resolve({ results: [result('wrong-mode')], total: 1 }); await tick(); assert.equal(opened.length, 0, 'A pending Enter cannot open the previous mode result');
    jobs[2].resolve({ results: [result('new-tab', { readingIds: [], tabIds: [42] })], total: 1 });
    await waitFor(() => api.shadow.querySelector('.qs-badge-tabs'), 'Only current mode result becomes selectable');
    modeRace.key(input, 'Enter'); await waitFor(() => opened.length === 1, 'A new Enter opens the current mode result');
    assert.equal(opened[0].row.id, 'new-tab'); assert.equal(opened[0].modeId, 'mode1');
    const nextApi = modeRace.open({ search: (query, context) => new Promise(resolve => jobs.push({ query, ...context, resolve })), onOpen: async (row, context) => { opened.push({ row, ...context }); } });
    jobs[3].resolve({ results: [result('before-settings')], total: 1 });
    await waitFor(() => nextApi.shadow.querySelector('.qs-result'), 'A new invocation is ready');
    const nextInput = nextApi.shadow.querySelector('input'); nextInput.value = 'settings'; nextInput.dispatchEvent(new modeRace.w.Event('input')); modeRace.key(nextInput, 'Enter');
    const newModes = modeRace.w.LaterOnQuickModes.normalize(); newModes[0].sources = ['bookmarks']; nextApi.setModes(newModes);
    jobs[4].resolve({ results: [result('stale-source')], total: 1 }); await tick(); assert.equal(opened.length, 1, 'A same-slot source configuration change also cancels pending confirmation');
    jobs[5].resolve({ results: [result('current-bookmark', { readingIds: [], bookmarkIds: ['native-9'] })], total: 1 });
    await waitFor(() => nextApi.shadow.querySelector('.qs-badge-bookmark'), 'Updated source scope is ready');
    modeRace.key(nextInput, 'Enter'); await waitFor(() => opened.length === 2, 'Only a fresh confirmation opens after settings change');
    assert.equal(opened[1].row.id, 'current-bookmark'); assert.equal(opened[1].sources.join(','), 'bookmarks');
  } finally { modeRace.w.close(); }

  const icons = fixture();
  try {
    const observers = [];
    icons.w.IntersectionObserver = class {
      constructor(callback, options) { this.callback = callback; this.options = options; this.nodes = new Set(); observers.push(this); }
      observe(node) { this.nodes.add(node); } unobserve(node) { this.nodes.delete(node); } disconnect() { this.nodes.clear(); }
    };
    const url = 'https://example.test/page?q=kept#fragment';
    const api = icons.open({ search: async () => ({ results: [result('icon', { url }), result('native', { url: 'chrome://extensions/', readingIds: [], tabIds: [8], title: '<script>tab title</script>' }), result('unsafe', { url: 'javascript:alert(1)' })], total: 2 }), onOpen: async () => {} });
    const s = api.shadow;
    await waitFor(() => s.querySelectorAll('.qs-result').length === 2, 'Protected tabs remain safely visible while unsafe library URLs are rejected');
    const image = s.querySelector('img'), fallback = image.parentElement.querySelector('.qs-site-fallback');
    assert.equal(s.activeElement, s.querySelector('input')); assert.equal(image.hasAttribute('src'), false, 'Pending icon visibility never blocks focus or results');
    assert(s.querySelectorAll('.qs-site-fallback svg').length === 1, 'Protected URLs use a transparent globe fallback');
    assert.equal(s.querySelectorAll('.qs-result-title')[1].textContent, '<script>tab title</script>');
    observers[0].callback([{ target: image, isIntersecting: true }]);
    assert.equal(new icons.w.URL(image.src).searchParams.get('pageUrl'), url, 'Cached favicon key preserves complete URL');
    image.dispatchEvent(new icons.w.Event('load')); assert.equal(fallback.hidden, true);
    image.dispatchEvent(new icons.w.Event('error')); assert.equal(fallback.hidden, false); assert.equal(image.isConnected, false, 'Failed icons leave usable fallback without a broken image');
    api.close(); assert.equal(observers[0].nodes.size, 0);
  } finally { icons.w.close(); }
  console.log('PASS Quick Switcher UI: source modes/prefixes, IME, stale confirmation, cached icons, protected tabs, isolated themes, keyboard/focus, resize, errors/retry and safe text');
})().catch(error => { console.error(error); process.exitCode = 1; });

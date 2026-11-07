const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = (id, projectId = 'research', savedAt = 1) => ({ id, projectId, savedAt, title: id,
  url: `https://example.test/${id}`, source: 'example.test', description: '', image: '', favicon: '', status: 'unread' });
function fixture(snapshot, pending, context) {
  const errors = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(read('sidepanel.html'), { url: 'chrome-extension://fixture/sidepanel.html',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const window = dom.window, changes = new Set(), frames = [], messages = [];
  const values = new Map([['laterOnPanelCache', JSON.stringify(snapshot)]]);
  if (context) values.set('laterOnPanelCacheContext', JSON.stringify(context));
  Object.defineProperty(window, 'localStorage', { value: { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) } });
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  window.cancelAnimationFrame = () => {};
  window.scrollTo = () => {};
  window.LaterOnI18n = { ready: Promise.resolve(), t: (key, vars) => key === 'cardCount' ? String(vars.n) : key, applyStatic() {} };
  window.chrome = {
    storage: { local: { get: keys => Array.isArray(keys) && keys.includes('laterOnItems') ? pending : Promise.resolve({}), async set() {} },
      onChanged: { addListener: fn => changes.add(fn), removeListener: fn => changes.delete(fn) } },
    runtime: { getURL: name => `chrome-extension://fixture/${name}`, onMessage: { addListener: fn => messages.push(fn) }, async sendMessage() { return { ok: false }; } },
    windows: { async getCurrent() { return { id: 7 }; } },
    tabs: { async query() { return []; }, onActivated: { addListener() {} }, onUpdated: { addListener() {} } }
  };
  for (const file of ['boot.js', 'url-utils.js', 'sidepanel.js']) window.eval(read(file));
  return { window, dom, frames, errors, messages, values, change(key, value) { for (const fn of [...changes]) fn({ [key]: { newValue: value } }, 'local'); },
    paint() { for (const callback of frames.splice(0)) callback(0); } };
}
(async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const cached = { version: 2, items: [item('second', 'research', 1), item('first', 'research', 100)], count: 1234,
    projects: [{ id: 'research', name: 'Research' }, { id: 'other', name: 'Other' }], archivedProjectIds: [],
    activeProject: 'research', filter: 'all', sortMode: 'custom', autoMarkRead: false,
    orders: { research: ['second', 'first'] } };
  const warm = fixture(cached, pending);
  try {
    await tick(); await tick();
    assert.deepEqual([...warm.window.document.querySelectorAll('#items .item')].map(node => node.dataset.id), ['second', 'first'],
      'A prepared project-specific first screen keeps custom order while the complete data request is pending');
    assert.equal(warm.window.document.querySelector('#itemCount').textContent, '1234', 'The cached first screen retains the actual collection count');
    assert.equal(warm.window.document.querySelector('#bootSkeleton'), null);
    assert.equal(warm.window.document.querySelector('#projectFilters .active .project-name').textContent, 'Research');
    const handshake = await new Promise(resolve => warm.messages.forEach(fn => fn({ type: 'PING_SIDEPANEL', windowId: 7 }, {}, resolve)));
    assert.equal(handshake.ready, true, 'The loaded cached surface can answer navigation handshakes');
    warm.paint();
    release({ laterOnItems: [item('latest')], laterOnProjects: cached.projects, laterOnActiveProject: 'research',
      laterOnSettings: {}, laterOnFilterChosen: true, laterOnFilter: 'all' });
    await new Promise(resolve => setTimeout(resolve, 5)); await tick();
    assert.deepEqual([...warm.window.document.querySelectorAll('#items .item')].map(node => node.dataset.id), ['latest']);
    assert.deepEqual(warm.errors, []);
  } finally { warm.dom.window.close(); }

  const original = { laterOnItems: [item('old')], laterOnProjects: cached.projects,
    laterOnActiveProject: 'research', laterOnSettings: {}, laterOnFilterChosen: true, laterOnFilter: 'all' };
  const race = fixture(cached, Promise.resolve(original));
  try {
    await tick(); await tick();
    race.change('laterOnActiveProject', 'other');
    race.change('laterOnItems', [item('new', 'other')]);
    race.paint();
    await new Promise(resolve => setTimeout(resolve, 5)); await tick();
    assert.equal(race.window.document.querySelector('#projectFilters .active .project-name').textContent, 'Other', 'A project change after the prefetch settles survives the first paint yield');
    assert.deepEqual([...race.window.document.querySelectorAll('#items .item')].map(node => node.dataset.id), ['new'],
      'A newer storage update cannot be overwritten by the old prefetched collection');
    assert.deepEqual(race.errors, []);
  } finally { race.dom.window.close(); }

  const saving = fixture(null, Promise.resolve({ ...original, laterOnItems: [item('first'), item('second')] }));
  try {
    await tick(); await tick();
    const input = saving.window.document.querySelector('#searchInput');
    input.value = 'first';
    input.dispatchEvent(new saving.window.Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 450));
    const array = JSON.parse(saving.values.get('laterOnPanelCache'));
    const context = JSON.parse(saving.values.get('laterOnPanelCacheContext'));
    assert.deepEqual(array.map(entry => entry.id).sort(), ['first', 'second'], 'A search cannot replace the ordinary launch preview with its result slice');
    assert.equal(context.count, 2);
    const reopened = fixture(array, new Promise(() => {}), context);
    try {
      await tick(); await tick();
      assert.equal(reopened.window.document.querySelector('#itemCount').textContent, '2', 'A written legacy-compatible array and its matching context restore the full count');
      assert.deepEqual([...reopened.window.document.querySelectorAll('#items .item')].map(node => node.dataset.id).sort(), ['first', 'second']);
    } finally { reopened.dom.window.close(); }
    saving.change('laterOnProjects', [{ id: 'research', name: 'Research', archived: true }]);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(JSON.parse(saving.values.get('laterOnPanelCache')), [], 'Archiving while searching removes those pages from the next launch preview');
    assert(JSON.parse(saving.values.get('laterOnPanelCacheContext')).archivedProjectIds.includes('research'));
    assert.deepEqual(saving.errors, []);
  } finally { saving.dom.window.close(); }
  console.log('PASS reading first screen: cached project/filter/order/count, paint opportunity, startup races, compatible cache round-trip and archive changes during search');
})().catch(error => { console.error(error); process.exitCode = 1; });

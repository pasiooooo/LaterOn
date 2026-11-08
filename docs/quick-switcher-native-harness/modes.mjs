// Native validation in the owned LaterOn Chrome profile. No service-worker
// debugger is attached; calls go through real extension-page messages.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const work = '/private/tmp/lateron-instant-native-work';
const loaded = '/private/tmp/lateron-instant-native-ext-baseline';
const extension = option('extension', 'ifkjnimbijeafkmehbhchmamkpnhphac');
const prefix = `chrome-extension://${extension}/`;
const port = Number(option('port', 9333));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = `${work}/modes-${stamp}`;
fs.mkdirSync(dir, { recursive: true });
const report = { at: new Date().toISOString(), extension, port, checks: [], timings: [], errors: [],
  boundary: ['Owned native Chrome profile, 50000 synthetic bookmarks and 5000 synthetic Reading pages.',
    'Loaded test manifest makes Bookmarks required; real permission removal is covered by the automated fixture suite, not this native profile.',
    'Worker remains unattached during these tests. OS Alt/Option+O is not dispatched by CDP; the native client SHOW message is tested.',
    'Favicon evidence uses a local test site with a real Chrome cache entry; this does not guarantee every remote website icon.'] };
const save = () => fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2) + '\n');
const log = value => console.log(`[${new Date().toISOString().slice(11, 19)}] ${value}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, next = 0;
const pending = new Map(), contexts = new Map(), owned = [];
async function send(method, params = {}, sessionId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(tab, expression, contextId, timeout = 15000, awaitPromise = true) {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise,
    ...(contextId ? { contextId } : {}) }, tab.sessionId, timeout);
  if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
}
async function until(task, predicate, label, timeout = 12000, interval = 30) {
  const started = Date.now(); let value, last;
  for (;;) {
    try { value = await task(); if (predicate(value)) return value; } catch (error) { last = error.message; }
    if (Date.now() - started > timeout) throw Error(`${label}: ${JSON.stringify(value)} ${last || ''}`);
    await delay(interval);
  }
}
async function openTab(url, background = false) {
  const { targetId } = await send('Target.createTarget', { url, background }); owned.push(targetId);
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const tab = { targetId, sessionId, url };
  contexts.set(sessionId, []);
  await Promise.all([send('Runtime.enable', {}, sessionId), send('Page.enable', {}, sessionId)]);
  try { await until(() => evaluate(tab, '({url:location.href,state:document.readyState})'), value => value?.url === url && value.state === 'complete', 'open ' + url, 5000); }
  catch (error) {
    if (!url.startsWith(prefix)) throw error;
    await send('Page.navigate', { url }, sessionId);
    await until(() => evaluate(tab, '({url:location.href,state:document.readyState})'), value => value?.url === url && value.state === 'complete', 'retry open ' + url);
  }
  return tab;
}
async function key(tab, name, contextId) {
  const map = { Tab: [9, 'Tab'], Backspace: [8, 'Backspace'], Escape: [27, 'Escape'], Enter: [13, 'Enter'], Space: [32, 'Space'] };
  const [code, domCode] = map[name];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name === 'Space' ? ' ' : name, code: domCode,
    windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(name === 'Space' ? { text: ' ' } : {}) }, tab.sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name === 'Space' ? ' ' : name, code: domCode,
    windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }, tab.sessionId);
}
async function click(tab, expression, contextId) {
  const rect = await evaluate(tab, `(() => { const node=${expression}; node.scrollIntoView({block:'center'});
    const r=node.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`, contextId);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', {
    type, ...rect, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, tab.sessionId);
}
async function check(name, task) {
  const started = Date.now();
  try { const evidence = await task(); report.checks.push({ name, ok: true, ms: Date.now() - started, evidence }); log('PASS ' + name); }
  catch (error) { report.checks.push({ name, ok: false, ms: Date.now() - started, error: error.message }); report.errors.push(name + ': ' + error.message); log('FAIL ' + name + ': ' + error.message); }
  save();
}
let harness, manager, web, world, settings;
const message = value => evaluate(harness, `chrome.runtime.sendMessage(${JSON.stringify(value)})`, undefined, 30000);
const search = (query, modeId = 'default') => message({ type: 'QUICK_SWITCHER_SEARCH', query, modeId });
const getMeta = () => evaluate(harness, `(async()=>({search:await LaterOnLocalIndex.info(),book:await LaterOnLocalIndex.info('bookmarks'),
  pending:(await chrome.storage.local.get('laterOnQuickSearchPending')).laterOnQuickSearchPending||null}))()`);
const waitReady = async label => {
  const start = Date.now();
  const state = await until(getMeta, value => value?.search?.ready === true && value.search.sourceViews === true
    && !value.search.pending && value.book?.ready === true && !value.book.pending && !value.pending, label, 300000, 1000);
  report.readiness ||= []; report.readiness.push({ label, ms: Date.now() - start, state }); save(); return state;
};
const modes = sources => evaluate(harness, `(() => { const modes=LaterOnQuickModes.normalize(); modes[0].sources=${JSON.stringify(sources)};
  return chrome.runtime.sendMessage({type:'LATERON_SETTINGS_SET',patch:{quickSwitcherModes:modes}}); })()`);
const workerState = async () => (await send('Target.getTargets')).targetInfos.filter(target => target.type === 'service_worker' && target.url.startsWith(prefix));
async function stopWorker() {
  for (const target of await workerState()) await send('Target.closeTarget', { targetId: target.targetId });
  await until(workerState, value => !value.length, 'worker stopped', 8000);
  await delay(100); assert.equal((await workerState()).length, 0);
}
async function shadowState() {
  return evaluate(web, `(() => { const ui=LaterOnQuickSwitcherUI.active, sh=ui?.shadow; return {mode:ui?.modeId||null,
    query:sh?.querySelector('.qs-input')?.value, focused:!!sh&&sh.activeElement===sh.querySelector('.qs-input'),
    rows:sh?.querySelectorAll('.qs-result').length||0, signature:[...sh?.querySelectorAll('.qs-result')||[]].map(n=>n.textContent).join('|'),
    busy:sh?.querySelector('.qs-list')?.getAttribute('aria-busy'),count:sh?.querySelector('.qs-count')?.textContent}; })()`, world);
}
const icon = fs.readFileSync(path.join(loaded, 'icon32.png'));
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/favicon.png')) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' }); return res.end(icon); }
  const url = new URL(req.url, 'http://localhost');
  const title = url.pathname === '/shared' ? 'NativeJoined8nqv ScopeToken8nqv' : url.pathname === '/tab'
    ? 'TabOnly8nqv ScopeToken8nqv' : 'LaterOn native modes article';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title><link rel="icon" href="/favicon.png"></head><body><h1>${title}</h1><p>Owned synthetic native fixture.</p></body></html>`);
});
const webPort = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const origin = `http://127.0.0.1:${webPort}`;
try {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.id && pending.has(value.id)) { const wait = pending.get(value.id); pending.delete(value.id); value.error ? wait.reject(Error(value.error.message)) : wait.resolve(value.result); }
    else if (value.method === 'Runtime.executionContextCreated') { const list = contexts.get(value.sessionId); if (list) list.push(value.params.context); }
    else if (value.method === 'Runtime.executionContextsCleared') contexts.set(value.sessionId, []);
  };
  report.browser = await send('Browser.getVersion');
  report.scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex');
  report.sourceHashes = JSON.parse(fs.readFileSync(path.join(work, 'current-install-hashes.json')));
  manager = await openTab('chrome://extensions/');
  await evaluate(manager, `chrome.developerPrivate.reload('${extension}',{failQuietly:true}).then(()=>true)`, undefined, 30000);
  await until(() => evaluate(manager, `chrome.developerPrivate.getExtensionInfo('${extension}').then(i=>i.state)`), value => value === 'ENABLED', 'extension enabled');
  harness = await openTab(`${prefix}native-modes-harness.html`);
  report.nativeStart = await evaluate(harness, `(async()=>{const stored=await chrome.storage.local.get(['laterOnItems','laterOnProjects','laterOnSettings','laterOnBookmarkConfig','laterOnOnboardingSeen']);
    globalThis.__savedModeState=stored; const tree=await chrome.bookmarks.getTree(),stack=[...tree];let pages=0;while(stack.length){const n=stack.pop();if(n.url)pages++;if(n.children)stack.push(...n.children);}
    return {version:chrome.runtime.getManifest().version,permissions:await chrome.permissions.getAll(),items:stored.laterOnItems?.length,bookmarks:pages,metadata:await LaterOnLocalIndex.info()};})()`);
  assert.equal(report.nativeStart.items, 5000); assert.equal(report.nativeStart.bookmarks, 50000);
  assert(!(await workerState()).some(target => target.attached), 'Measured worker must not be attached');
  save(); log('Native fixture starts at 50k Bookmarks + 5k Reading');
  // Add deterministic query fixtures in the native APIs; original reading
  // state stays in this owned harness page and is restored at the end.
  report.fixture = await evaluate(harness, `(async()=>{const origin=${JSON.stringify(origin)},shared=origin+'/shared?q=kept#section';
    const folder=await chrome.bookmarks.create({parentId:'1',title:'Native modes fixture'});
    const nodes=[await chrome.bookmarks.create({parentId:folder.id,title:'NativeBook8nqv ScopeToken8nqv',url:shared}),
      await chrome.bookmarks.create({parentId:folder.id,title:'BookOnly8nqv ScopeToken8nqv',url:origin+'/book?q=2#book'})];
    const base=__savedModeState,project={id:'native-modes-project',name:'ProjectJoined8nqv'};
    const items=[{id:'native-modes-shared',url:shared,title:'ReadingEdited8nqv ScopeToken8nqv',titleEdited:true,projectId:project.id,savedAt:1},
      {id:'native-modes-reading',url:origin+'/reading?q=3#read',title:'ReadingOnly8nqv ScopeToken8nqv',savedAt:2},
      ...Array.from({length:200},(_,i)=>({id:'native-modes-'+i,url:origin+'/many/'+i+'?q='+i+'#fragment',title:'Common ScopeToken8nqv '+i,savedAt:Date.now()+10000+i}))];
    globalThis.__nativeModes={folder:folder.id,nodes,items,project,shared,tabs:[]};
    await chrome.storage.local.set({laterOnItems:[...base.laterOnItems,...items],laterOnProjects:[...base.laterOnProjects,project],
      laterOnOnboardingSeen:true,laterOnSettings:{...base.laterOnSettings,theme:'dark',quickSwitcherModes:LaterOnQuickModes.normalize()},laterOnBookmarkConfig:{enabled:true,scopeId:null}});
    return {folder:folder.id,bookmarkIds:nodes.map(n=>n.id),readingAdded:items.length,shared};})()`);
  web = await openTab(`${origin}/shared?q=kept#section`);
  world = await until(async () => contexts.get(web.sessionId), list => list?.some(context => context.origin?.startsWith(prefix)
    || context.name === 'LaterOn' || context.auxData?.type === 'isolated' && context.name), 'isolated world');
  world = world.find(context => context.origin?.startsWith(prefix) || context.name === 'LaterOn' || context.auxData?.type === 'isolated' && context.name).id;
  const liveFixture = await evaluate(harness, `(async()=>{const f=__nativeModes;
    const tab=await chrome.tabs.create({url:${JSON.stringify(origin + '/tab?q=4#tab')},active:false});
    const other=await chrome.windows.create({url:f.shared,focused:false,type:'normal'});
    f.tabs=[tab.id,...other.tabs.map(t=>t.id)];f.otherWindow=other.id;
    return {nativeTabs:f.tabs,otherWindow:other.id};})()`); report.fixture = { ...report.fixture, ...liveFixture }; save();
  await until(() => evaluate(harness, `chrome.tabs.query({}).then(tabs=>tabs.filter(t=>(t.title||'').includes('ScopeToken8nqv')).map(t=>({id:t.id,url:t.url,title:t.title})))`), value => value.length >= 3, 'native titles ready');
  await search('ScopeToken8nqv', 'mode3');
  await waitReady('initial mode projections prepared');

  const combinations = [[['tabs'], 2], [['reading'], 202], [['bookmarks'], 2], [['tabs', 'reading'], 203],
    [['tabs', 'bookmarks'], 3], [['reading', 'bookmarks'], 203], [['tabs', 'reading', 'bookmarks'], 204]];
  const before = await getMeta();
  for (const [sources, total] of combinations) await check('native combination ' + sources.join('+'), async () => {
    assert.equal((await modes(sources)).ok, true);
    const response = await search('ScopeToken8nqv'); assert.equal(response.ok, true); assert(!response.cancelled);
    assert.equal(response.total, total); assert.equal(response.results.length, Math.min(total, 50)); assert.equal(response.provisional, undefined);
    assert.equal(response.sourcesFiltered, true); assert(!('lookupEntries' in response));
    for (const entry of response.results) {
      if (!sources.includes('tabs')) assert.equal(entry.tabIds?.length || 0, 0);
      if (!sources.includes('reading')) { assert.equal(entry.readingIds.length, 0); assert.equal(entry.projectNames.length, 0); }
      if (!sources.includes('bookmarks')) { assert.equal(entry.bookmarkIds.length, 0); assert.equal(entry.folderNames.length, 0); }
    }
    return { total: response.total, rows: response.results.length, generation: response.generation };
  });
  await check('native snapshot total and out-of-first-50 overlap', async () => {
    await modes(['reading']); const reading = await search('ScopeToken8nqv'); assert(!reading.results.some(row => row.url === report.fixture.shared));
    await modes(['tabs', 'reading', 'bookmarks']); const cross = await search('NativeJoined8nqv ProjectJoined8nqv');
    assert.equal(cross.total, 1); const row = cross.results[0]; assert.equal(row.url, report.fixture.shared);
    assert.equal(row.title, 'ReadingEdited8nqv ScopeToken8nqv'); assert.equal(row.readingIds.length, 1); assert.equal(row.bookmarkIds.length, 1); assert.equal(row.tabIds.length, 2);
    const after = await getMeta(); assert.equal(after.search.generation, before.search.generation); assert.equal(after.search.revision, before.search.revision);
    return { readingSliceOmitsShared: true, mergedCrossSourceRow: row, unchangedGeneration: after.search.generation };
  });
  await check('native source-specific matching and display', async () => {
    const book = await search('NativeBook8nqv', 'mode3'); assert.equal(book.total, 1); assert.equal(book.results[0].title, 'NativeBook8nqv ScopeToken8nqv');
    assert.equal((await search('ReadingEdited8nqv', 'mode3')).total, 0); assert.equal((await search('ProjectJoined8nqv', 'mode3')).total, 0);
    assert.equal((await search('NativeJoined8nqv', 'mode2')).total, 0); assert.equal((await search('NativeBook8nqv', 'mode2')).total, 0);
    return { bookmarkTitle: book.results[0].title, isolated: true };
  });
  await check('native configuration RPC and persistence across page reload', async () => {
    settings = await openTab(`${prefix}settings.html`);
    await until(() => evaluate(settings, `!!document.querySelector('#quickModesForm[data-ready]')`), value => value, 'Settings ready');
    const response = await evaluate(settings, `(() => { const modes=LaterOnQuickModes.normalize();modes[1].prefix='@';modes[2].prefix='/';modes[3].prefix='\t';
      return Promise.all([LaterOnSettings.set({quickSwitcherModes:modes}),LaterOnSettings.set({theme:'light'})]).then(()=>LaterOnSettings.get()); })()`);
    assert.equal(response.quickSwitcherModes[2].prefix, '/'); assert.equal(response.theme, 'light');
    await send('Page.reload', {}, settings.sessionId);
    const restored = await until(() => evaluate(settings, `({ready:!!document.querySelector('#quickModesForm[data-ready]'),slash:document.querySelector('[data-mode-id="mode2"] [data-prefix-value]')?.value,tab:document.querySelector('#quickModePrefix-mode3')?.value,theme:document.documentElement.dataset.theme})`), value => value.ready && value.slash === '/' && value.tab === 'tab', 'Settings reload');
    return restored;
  });
  await check('native custom trigger and reassigned Tab preserve query', async () => {
    await send('Page.bringToFront', {}, web.sessionId);
    await evaluate(web, `LaterOnQuickSwitcherClient.show({})`, world);
    await until(shadowState, value => value.focused && value.rows, 'switcher open');
    await send('Input.insertText', { text: '/ ReadingEdited8nqv' }, web.sessionId);
    await until(shadowState, value => value.mode === 'mode2' && value.query === 'ReadingEdited8nqv' && value.signature.includes('ReadingEdited8nqv'), 'slash trigger');
    await key(web, 'Tab'); const switched = await until(shadowState, value => value.mode === 'mode3' && value.query === 'ReadingEdited8nqv', 'reassigned Tab');
    await key(web, 'Escape'); return switched;
  });
  await modes(['tabs', 'reading', 'bookmarks']);
  await message({ type: 'LATERON_SETTINGS_SET', patch: { theme: 'dark' } });
  await evaluate(web, `(() => {
    globalThis.__nativeSearchReplies=[];
    const original=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=function(message,...args){
      const result=original(message,...args);
      if(message?.type==='QUICK_SWITCHER_SEARCH') Promise.resolve(result).then(reply=>__nativeSearchReplies.push({at:performance.now(),query:message.query,modeId:message.modeId,
        active:message.active,ok:reply?.ok,total:reply?.total,rows:reply?.results?.length,provisional:reply?.provisional,cancelled:reply?.cancelled,generation:reply?.generation,revision:reply?.revision}),()=>{});
      return result;
    }; return true;
  })()`, world);
  // SHOW performs the same native dispatch as the webpage client. Record focus
  // and visible real rows independently of icon download/completion.
  for (let rep = 0; rep < 5; rep++) await check('native invocation ' + rep, async () => {
    await send('Page.bringToFront', {}, web.sessionId);
    await key(web, 'Escape'); await message({ type: 'QUICK_SWITCHER_ACTIVITY', active: false });
    const cold = rep % 2 === 1; if (cold) await stopWorker();
    const atTrigger = await workerState(); assert(!atTrigger.some(target => target.attached));
    await evaluate(web, `(() => { globalThis.__modeTiming={};const start=performance.now();globalThis.__modeTiming.start=start;
      const tick=()=>{const ui=LaterOnQuickSwitcherUI.active,sh=ui?.shadow,now=performance.now(),m=__modeTiming;
        if(sh&&sh.activeElement===sh.querySelector('.qs-input')&&m.focus==null)m.focus=now-start;
        if(sh?.querySelector('.qs-result')&&m.rows==null)m.rows=now-start;
        if((m.focus==null||m.rows==null)&&now-start<10000)requestAnimationFrame(tick);};requestAnimationFrame(tick);
      chrome.runtime.sendMessage({type:'QUICK_SWITCHER_SHOW'}).then(r=>{__modeTiming.showResponse=r;});return true;})()`, world);
    await until(() => evaluate(web, `globalThis.__modeTiming`, world), value => value.focus != null && value.rows != null, 'timed native invocation');
    const beforeQuery = await shadowState(); assert(beforeQuery.rows > 1, 'The unique-query result must differ from the original list');
    const searchStart = await evaluate(web, 'performance.now()', world);
    await send('Input.insertText', { text: 'NativeJoined8nqv ProjectJoined8nqv' }, web.sessionId);
    const unique = await until(shadowState, value => value.query === 'NativeJoined8nqv ProjectJoined8nqv'
      && value.signature.includes('ReadingEdited8nqv') && value.rows === 1 && value.busy === 'false', 'cross query rendered');
    const timing = await evaluate(web, `globalThis.__modeTiming`, world);
    timing.queryMs = (await evaluate(web, 'performance.now()', world)) - searchStart;
    timing.queryRows = unique.rows; timing.queryCount = unique.count; timing.rep = rep; timing.cold = cold;
    timing.replies=await evaluate(web, 'globalThis.__nativeSearchReplies.slice(-6)', world);
    timing.indexAtQuery=await getMeta();
    timing.workerAtTrigger = atTrigger.length > 0; timing.nativeDataPages = 55204; report.timings.push(timing);
    if (rep === 0) {
      await until(() => evaluate(web, `(() => {const images=[...LaterOnQuickSwitcherUI.active.shadow.querySelectorAll('.qs-favicon')];return images.map(i=>({src:i.src,width:i.naturalWidth,complete:i.complete}));})()`, world), value => value.some(image => image.width > 0), 'real cached favicon');
      const icons = await evaluate(web, `(() => {const sh=LaterOnQuickSwitcherUI.active.shadow,i=sh.querySelector('.qs-favicon');return {src:i?.src,width:i?.naturalWidth,background:i?getComputedStyle(i.parentElement).backgroundColor:null};})()`, world);
      assert(icons.src.startsWith(prefix + '_favicon/')); assert.equal(icons.background, 'rgba(0, 0, 0, 0)'); timing.icons = icons;
      const screen = await send('Page.captureScreenshot', { format: 'png' }, web.sessionId); fs.writeFileSync(`${dir}/native-favicon-dark.png`, Buffer.from(screen.data, 'base64'));
      report.screenshot = `${dir}/native-favicon-dark.png`;
    }
    await key(web, 'Escape'); return timing;
  });
  await check('native library opening reuses exact tab and focuses its window', async () => {
    // Leave the exact target URL open only in the second normal window, so
    // window focusing has an observable before/after result.
    await send('Target.closeTarget', { targetId: web.targetId });
    const response = await search('ReadingEdited8nqv', 'mode2'), row = response.results[0];
    await send('Page.bringToFront', {}, harness.sessionId);
    const activeBefore = await evaluate(harness, `chrome.windows.getAll().then(windows=>windows.filter(w=>w.focused).map(w=>w.id))`);
    const started = Date.now();
    const outcome = await message({ type: 'QUICK_SWITCHER_OPEN', id: row.id, modeId: 'mode2' }); assert.equal(outcome.ok, true); assert.equal(outcome.reused, true);
    const active = await evaluate(harness, `chrome.tabs.query({active:true}).then(tabs=>tabs.filter(t=>t.url===${JSON.stringify(report.fixture.shared)}).map(t=>({id:t.id,url:t.url,windowId:t.windowId})))`);
    const windows = await evaluate(harness, `chrome.windows.getAll().then(windows=>windows.map(w=>({id:w.id,focused:w.focused})))`);
    assert(active.some(tab=>windows.some(window=>window.id===tab.windowId&&window.focused)), 'The existing target window is focused after opening');
    assert(!activeBefore.some(id=>active.some(tab=>tab.windowId===id)), 'The initial focused window differs from the target');
    return { outcome, active, windows, activeBefore, ms: Date.now()-started };
  });
  await check('native closed and navigated tab-only rows never recreate old URLs', async () => {
    const found = await search('TabOnly8nqv', 'mode1'), row = found.results[0]; assert(row?.id.startsWith('tab:'));
    const tabId = row.tabIds[0];
    await evaluate(harness, `chrome.tabs.update(${tabId},{url:${JSON.stringify(origin + '/changed?q=new#fragment')}})`);
    const before = await evaluate(harness, `chrome.tabs.query({}).then(tabs=>tabs.map(tab=>({id:tab.id,url:tab.pendingUrl||tab.url})).sort((a,b)=>a.id-b.id))`);
    const changed = await message({ type: 'QUICK_SWITCHER_OPEN', modeId: 'mode1', id: row.id }); assert.equal(changed.ok, false);
    const afterNavigation = await evaluate(harness, `chrome.tabs.query({}).then(tabs=>tabs.map(tab=>({id:tab.id,url:tab.pendingUrl||tab.url})).sort((a,b)=>a.id-b.id))`);
    assert.deepEqual(afterNavigation, before, 'Refused navigation leaves the native tab ID/URL set unchanged');
    await evaluate(harness, `chrome.tabs.remove(${tabId})`);
    const beforeClosed = await evaluate(harness, `chrome.tabs.query({}).then(tabs=>tabs.map(tab=>({id:tab.id,url:tab.pendingUrl||tab.url})).sort((a,b)=>a.id-b.id))`);
    const closed = await message({ type: 'QUICK_SWITCHER_OPEN', modeId: 'mode1', id: row.id }); assert.equal(closed.ok, false);
    const afterClosed = await evaluate(harness, `chrome.tabs.query({}).then(tabs=>tabs.map(tab=>({id:tab.id,url:tab.pendingUrl||tab.url})).sort((a,b)=>a.id-b.id))`);
    assert.deepEqual(afterClosed, beforeClosed, 'Refused closed target creates no native tab');
    assert.equal((await search('TabOnly8nqv', 'mode1')).total, 0); return { changed, closed, nativeSetUnchanged: true };
  });
  await check('native bookmark scope changes restrict search and old opening', async () => {
    const old = (await search('NativeBook8nqv', 'mode3')).results[0];
    await evaluate(harness, `chrome.storage.local.set({laterOnBookmarkConfig:{enabled:false,scopeId:null}})`);
    const disabled = await search('NativeBook8nqv', 'mode3'); assert.equal(disabled.total, 0);
    const refused = await message({ type: 'QUICK_SWITCHER_OPEN', id: old.id, modeId: 'mode3' }); assert.equal(refused.ok, false);
    await evaluate(harness, `chrome.storage.local.set({laterOnBookmarkConfig:{enabled:true,scopeId:${JSON.stringify(report.fixture.folder)}}})`);
    const scoped = await search('NativeBook8nqv', 'mode3'); assert.equal(scoped.total, 1); assert.equal(scoped.results[0].readingIds.length, 0);
    await evaluate(harness, `chrome.storage.local.set({laterOnBookmarkConfig:{enabled:true,scopeId:null}})`);
    return { disabledTotal: disabled.total, refused: refused.ok, scopedTotal: scoped.total };
  });
  await waitReady('restored all-bookmark scope');
  await check('native old schema5 bookmark-only fallback repairs in background', async () => {
    const oldMeta = await evaluate(harness, `(async()=>{const db=await new Promise((r,j)=>{const q=indexedDB.open('lateron-local-index-v1',5);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
      const old=await new Promise((r,j)=>{const tx=db.transaction('searchMeta','readwrite'),s=tx.objectStore('searchMeta'),q=s.get('search');let old;
        q.onsuccess=()=>{old=q.result;const next={...old};delete next.sourceViews;delete next.sharedPages;s.put(next);s.delete('searchSources');};tx.oncomplete=()=>r(old);tx.onabort=()=>j(tx.error);});db.close();return {generation:old.generation,schema:old.schema};})()`);
    const fallback = await search('NativeBook8nqv', 'mode3'); assert.equal(fallback.ok, true); assert.equal(fallback.total, 1); assert.equal(fallback.provisional, true);
    await message({ type: 'QUICK_SWITCHER_ACTIVITY', active: false });
    const repaired = await waitReady('schema5 source projection upgrade'); assert(repaired.search.generation > oldMeta.generation); assert.equal(repaired.search.schema, 5);
    const final = await search('NativeBook8nqv', 'mode3'); assert.equal(final.total, 1); assert.equal(final.provisional, undefined);
    assert(!(await workerState()).some(target => target.attached)); return { oldMeta, repairedGeneration: repaired.search.generation, fallbackTotal: fallback.total };
  });
} catch (error) { report.errors.push(error.message); log('ERROR ' + error.message); }
finally {
  if (harness && ws?.readyState === WebSocket.OPEN) {
    try {
      const restored = await evaluate(harness, `(async()=>{const f=globalThis.__nativeModes;if(f){for(const id of f.tabs||[])await chrome.tabs.remove(id).catch(()=>{});
        if(f.otherWindow)await chrome.windows.remove(f.otherWindow).catch(()=>{});await chrome.bookmarks.removeTree(f.folder).catch(()=>{});}
        if(globalThis.__savedModeState)await chrome.storage.local.set(__savedModeState);return {readingRestored:__savedModeState?.laterOnItems?.length||null,fixtureRemoved:!!f};})()`);
      report.restored = restored;
    } catch (error) { report.errors.push('restore: ' + error.message); }
  }
  if (ws?.readyState === WebSocket.OPEN) {
    report.workerAtEnd = await workerState().catch(() => []);
    for (const targetId of owned) await send('Target.closeTarget', { targetId }).catch(() => {});
    ws.close();
  }
  server.close();
  report.complete = true; report.passed = report.checks.filter(check => check.ok).length;
  report.failed = report.checks.filter(check => !check.ok).map(check => check.name); report.ok = !report.errors.length; save();
  console.log(JSON.stringify({ report: `${dir}/report.json`, passed: report.passed, failed: report.failed, errors: report.errors, timings: report.timings }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

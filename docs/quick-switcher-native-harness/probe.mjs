// Launches an owned Chrome/Chromium profile, loads LaterOn through the native
// extension system (CDP Extensions.loadUnpacked), applies the synthetic seed
// through the real extension worker and records native capabilities.
// The browser stays open while this process runs (for follow-up measurement
// via --remote-debugging-port). Stop: Ctrl-C / SIGTERM / touch work/STOP.
//
// node probe.mjs --ext <dir> --profile <dir> [--browser auto|chrome|chromium]
//   [--seed <json>] [--port 9333] [--out <json>] [--exit]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? true : all[index + 1]]);
  return pairs;
}, []));
// Keep owned native processes alive across task continuations. The normal
// launcher enforces owned paths/STOP; measurements exit when their report ends.
if (args.detach) {
  if (args['view-state'] || args['prepare-timing'] || args.attach || args.diagnose) throw Error('detach supports the owned launcher and bounded measurements only');
  const launcherWork = '/private/tmp/lateron-instant-native-work';
  fs.mkdirSync(launcherWork, { recursive: true });
  const launcherStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const launcherKind = args.measure ? 'measure' : 'launcher';
  const launcherLog = `${launcherWork}/detached-${launcherKind}-${launcherStamp}.log`;
  const launcherFd = fs.openSync(launcherLog, 'a');
  const launcher = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter(value => value !== '--detach')],
    { cwd: launcherWork, detached: true, stdio: ['ignore', launcherFd, launcherFd] });
  launcher.unref(); fs.closeSync(launcherFd);
  const launcherRecord = { kind: launcherKind, pid: launcher.pid, log: launcherLog, at: new Date().toISOString(), ...(args.measure ? {} : { stop: `${launcherWork}/STOP` }) };
  fs.writeFileSync(`${launcherWork}/detached-${launcherKind}-current.json`, JSON.stringify(launcherRecord, null, 2) + '\n');
  console.log(JSON.stringify(launcherRecord, null, 2));
  process.exit(0);
}
// A laptop sleep invalidates wall-clock deadlines and native samples. Keep
// the machine awake only while an owned measurement/diagnostic is running.
if (args.measure || args.modes || args['view-state'] || args['prepare-timing']) {
  const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  awake.on('error', () => {});
  process.once('exit', () => { try { awake.kill('SIGTERM'); } catch {} });
}
// `probe.mjs --attach` reuses the approved command prefix to run the stepwise
// attach diagnostic against an already running browser; it launches nothing.
if (args['view-state']) { await import('./view-state.mjs'); await new Promise(() => {}); }
if (args['prepare-timing']) { await import('./prepare-timing.mjs'); await new Promise(() => {}); }
if (args.attach || args.diagnose || args.measure || args.modes || args['modes-diagnose'] || args['modes-focus']) {
  await import(args['modes-focus'] ? './modes-focus.mjs' : args['modes-diagnose'] ? './modes-diagnose.mjs' : args.modes ? './modes.mjs' : args.measure ? './measure.mjs' : args.diagnose ? './diagnose-background.mjs' : './attach-cdp.mjs');
  await new Promise(() => {});
}
const OWNED = '/private/tmp/lateron-instant-native-';
const work = '/private/tmp/lateron-instant-native-work';
const ext = path.resolve(args.ext || '/private/tmp/lateron-instant-native-ext-baseline');
const profile = path.resolve(args.profile || '/private/tmp/lateron-instant-native-profile-50k');
const port = Number(args.port || 9333);
const out = path.resolve(args.out || path.join(work, `probe-${path.basename(profile)}.json`));
const BROWSERS = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromium: '/Users/jzh/Library/Caches/ms-playwright/chromium-1161/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
};
for (const target of [ext, profile, out]) if (!target.startsWith(OWNED)) throw Error(`Refusing path outside ${OWNED}*: ${target}`);
fs.mkdirSync(profile, { recursive: true });
fs.rmSync(path.join(work, 'STOP'), { force: true });
const result = { startedAt: new Date().toISOString(), ext, profile, port, attempts: [] };
const save = () => fs.writeFileSync(out, JSON.stringify(result, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Minimal CDP client over --remote-debugging-pipe (fd 3 in, fd 4 out).
function launch(kind, extraArgs = []) {
  if (fs.existsSync(path.join(profile, 'SingletonLock'))) throw Error(`Profile already in use: ${profile}`);
  const stderrPath = path.join(work, `${path.basename(profile)}-${kind}.stderr.log`);
  const stderr = fs.openSync(stderrPath, 'w');
  const launchArgs = [`--user-data-dir=${profile}`, '--remote-debugging-pipe', `--remote-debugging-port=${port}`,
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--password-store=basic', '--use-mock-keychain', '--disable-features=MediaRouter,OptimizationHints',
    // Synthetic hosts never leave the machine; local test pages stay reachable.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    '--window-size=1280,900', ...extraArgs, 'about:blank'];
  const child = spawn(BROWSERS[kind], launchArgs, { stdio: ['ignore', 'ignore', stderr, 'pipe', 'pipe'] });
  const writer = child.stdio[3], reader = child.stdio[4];
  let id = 0, buffer = Buffer.alloc(0);
  const waiting = new Map(), listeners = new Set();
  reader.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end; (end = buffer.indexOf(0)) >= 0; buffer = buffer.subarray(end + 1)) {
      const message = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      if (message.id && waiting.has(message.id)) {
        const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id);
        message.error ? reject(Error(`${message.error.message} ${message.error.data || ''}`.trim())) : resolve(message.result);
      } else for (const listener of listeners) listener(message);
    }
  });
  writer.on('error', () => {}); reader.on('error', () => {});
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const send = (method, params = {}, sessionId, timeout = 30000) => new Promise((resolve, reject) => {
    const messageId = ++id;
    const timer = setTimeout(() => { waiting.delete(messageId); reject(Error(`CDP timeout ${method}`)); }, timeout);
    waiting.set(messageId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    writer.write(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  exited.then(state => { for (const { reject } of waiting.values()) reject(Error(`Browser exited ${JSON.stringify(state)}`)); });
  return { kind, child, send, listeners, exited, stderrPath, launchArgs };
}

async function workerSession(browser, extensionId, timeout = 15000) {
  const prefix = `chrome-extension://${extensionId}/`;
  for (const started = Date.now(); Date.now() - started < timeout; await sleep(100)) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const worker = targetInfos.find(info => info.type === 'service_worker' && info.url.startsWith(prefix));
    if (worker) {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
      return { sessionId, targetId: worker.targetId, url: worker.url };
    }
  }
  throw Error('Extension service worker target not found');
}
const evaluate = async (browser, sessionId, expression, timeout = 120000) => {
  const reply = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeout);
  if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
};
// Short, separately limited capability checks; one failure never hides the rest.
async function capabilities(browser, sessionId) {
  const native = {};
  const check = async (name, expression, timeout = 5000) => {
    const started = Date.now();
    try { native[name] = { ok: true, value: await evaluate(browser, sessionId, expression, timeout) }; }
    catch (error) { native[name] = { ok: false, error: String(error.message || error) }; }
    native[name].ms = Date.now() - started;
    save();
    return native[name];
  };
  await browser.send('Runtime.enable', {}, sessionId, 5000).catch(error => { native.runtimeEnable = String(error.message); });
  await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId, 5000).catch(error => { native.runIfWaiting = String(error.message); });
  result.native = native;
  const alive = await check('eval1plus1', '1+1');
  if (!alive.ok) return native;
  await check('manifestAndApis', `({ version: chrome.runtime.getManifest().version, bookmarks: typeof chrome.bookmarks,
    sidePanelOpen: typeof chrome.sidePanel?.open, sidePanelSetOptions: typeof chrome.sidePanel?.setOptions,
    quickSwitcher: typeof globalThis.LaterOnQuickSwitcher?.open, bookmarkSync: typeof globalThis.LaterOnBookmarkSync?.handle })`);
  const granted = await check('bookmarksPermission', `chrome.permissions.contains({ permissions: ['bookmarks'] })`);
  await check('permissions', 'chrome.permissions.getAll()');
  if (granted.ok && granted.value === true) {
    await check('bookmarkTree', `(async () => { const started = performance.now(); const tree = await chrome.bookmarks.getTree();
      const ms = performance.now() - started; let urls = 0, folders = 0; const stack = [...tree];
      while (stack.length) { const node = stack.pop(); node.url ? urls++ : folders++; if (node.children) stack.push(...node.children); }
      return { urls, folders, getTreeMs: Math.round(ms) }; })()`, 30000);
  } else native.bookmarkTree = { skipped: 'bookmarks permission not granted' };
  await check('commands', 'chrome.commands.getAll().then(list => list.map(c => [c.name, c.shortcut]))');
  await check('storageBytes', 'chrome.storage.local.getBytesInUse(null)');
  await check('windows', 'chrome.windows.getAll().then(list => list.map(w => ({ id: w.id, type: w.type })))');
  return native;
}

async function tryBrowser(kind) {
  const modes = kind === 'chromium' ? ['loadUnpacked', 'load-extension'] : ['loadUnpacked'];
  for (const mode of modes) {
    const attempt = { kind, mode, executable: BROWSERS[kind] };
    result.attempts.push(attempt); save();
    if (!fs.existsSync(BROWSERS[kind])) { attempt.error = 'executable missing'; return null; }
    let browser;
    try {
      browser = launch(kind, mode === 'load-extension' ? [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`] : []);
      attempt.stderr = browser.stderrPath; attempt.pid = browser.child.pid;
      attempt.version = await browser.send('Browser.getVersion');
      let extensionId;
      if (mode === 'loadUnpacked') {
        const loadStarted = Date.now();
        ({ id: extensionId } = await browser.send('Extensions.loadUnpacked', { path: ext }));
        attempt.loadUnpackedMs = Date.now() - loadStarted;
      } else {
        for (let i = 0; i < 50 && !extensionId; i++, await sleep(200)) {
          const { targetInfos } = await browser.send('Target.getTargets');
          extensionId = targetInfos.map(info => /^chrome-extension:\/\/([a-p]{32})\//.exec(info.url)?.[1]).find(Boolean);
        }
      }
      if (!extensionId) throw Error('No extension id');
      attempt.extensionId = extensionId; save();
      return { browser, extensionId, attempt };
    } catch (error) {
      attempt.error = String(error.message || error);
      if (browser) {
        try { await browser.send('Browser.close', {}, undefined, 5000); } catch { browser.child.kill('SIGTERM'); }
        await Promise.race([browser.exited, sleep(5000)]);
        try { attempt.stderrTail = fs.readFileSync(browser.stderrPath, 'utf8').split('\n').slice(-25).join('\n'); } catch {}
      }
      save();
    }
  }
  return null;
}

let active;
const order = args.browser === 'chromium' ? ['chromium'] : args.browser === 'chrome' ? ['chrome'] : ['chrome', 'chromium'];
for (const kind of order) if ((active = await tryBrowser(kind))) break;
if (!active) { result.ok = false; save(); console.log(JSON.stringify(result, null, 2)); process.exit(1); }
const { browser, extensionId, attempt } = active;
Object.assign(result, { browser: attempt.kind, mode: attempt.mode, version: attempt.version, extensionId,
  pid: browser.child.pid, launchArgs: browser.launchArgs, stderr: browser.stderrPath });

let capabilityWorker;
try {
  const worker = await workerSession(browser, extensionId);
  capabilityWorker = worker;
  result.worker = worker.url;
  const native = await capabilities(browser, worker.sessionId);
  if (!native.eval1plus1?.ok) throw Error(`worker eval failed: ${native.eval1plus1?.error}`);
  if (args.seed && native.bookmarksPermission?.value === true) {
    const seed = fs.readFileSync(path.resolve(args.seed), 'utf8');
    // Reading data is written once; bookmark sync is enabled through the
    // extension's own BOOKMARKS_CONFIG handler, timed as a native refresh.
    result.seed = await evaluate(browser, worker.sessionId, `(async () => {
      const marker = (await chrome.storage.local.get('laterOnNativeSeed')).laterOnNativeSeed;
      if (marker) return { skipped: true, marker };
      const seed = ${seed};
      const config = seed.laterOnBookmarkConfig; delete seed.laterOnBookmarkConfig;
      let started = performance.now();
      await chrome.storage.local.set({ ...seed, laterOnNativeSeed: { items: seed.laterOnItems.length, at: Date.now() } });
      const storageSetMs = Math.round(performance.now() - started);
      started = performance.now();
      const state = await LaterOnBookmarkSync.handle({ type: 'BOOKMARKS_CONFIG', enabled: config.enabled, scopeId: config.scopeId });
      return { items: seed.laterOnItems.length, storageSetMs, bookmarkEnableMs: Math.round(performance.now() - started),
        stateNodes: state?.nodes?.length, stateFolders: state?.folders?.length, stateError: state?.error || null,
        bytesInUse: await chrome.storage.local.getBytesInUse(null) };
    })()`, 600000);
  }
  result.ok = true;
} catch (error) {
  result.ok = false; result.error = String(error.message || error);
} finally {
  if (capabilityWorker) {
    try {
      await browser.send('Target.detachFromTarget', { sessionId: capabilityWorker.sessionId }, undefined, 5000);
      result.capabilityWorkerDetached = true;
    } catch (error) {
      const list = await browser.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
      result.capabilityWorkerDetached = !list.targetInfos.some(target => target.targetId === capabilityWorker.targetId && target.attached);
      if (!result.capabilityWorkerDetached) { result.ok = false; result.detachError = String(error.message || error); }
    }
  }
  const list = await browser.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
  result.attachedWorkersAtReady = list.targetInfos.filter(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`) && target.attached).map(target => target.targetId);
  if (result.attachedWorkersAtReady.length) { result.ok = false; result.detachError = 'Owned worker debugger is still attached'; }
}
result.readyAt = new Date().toISOString();
save();
console.log(JSON.stringify(result, null, 2));
console.log(result.ok ? `READY port=${port} extension=${extensionId} pid=${browser.child.pid}` : 'FAILED (browser left open for inspection)');

const stop = async reason => {
  result.stoppedAt = new Date().toISOString(); result.stopReason = reason; save();
  try { await browser.send('Browser.close', {}, undefined, 5000); } catch { browser.child.kill('SIGTERM'); }
  await Promise.race([browser.exited, sleep(5000)]);
  process.exit(result.ok ? 0 : 1);
};
if (args.exit) await stop('--exit');
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
browser.exited.then(state => { result.browserExited = state; save(); process.exit(result.ok ? 0 : 1); });
setInterval(() => { if (fs.existsSync(path.join(work, 'STOP'))) stop('STOP file'); }, 1000);

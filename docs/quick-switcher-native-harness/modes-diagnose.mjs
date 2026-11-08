import fs from 'node:fs';
const info = await fetch('http://127.0.0.1:9333/json/version').then(r => r.json());
const socket = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((resolve,reject) => {socket.onopen=resolve;socket.onerror=reject;});
const pending = new Map();let id=0;
socket.onmessage = ({data}) => {const m=JSON.parse(data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
const send = (method,params={},sessionId) => new Promise((resolve,reject)=>{const n=++id;const t=setTimeout(()=>reject(Error('timeout '+method)),10000);
  pending.set(n,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});socket.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));});
const {targetId}=await send('Target.createTarget',{url:'chrome://extensions/',background:false});
const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
await new Promise(r=>setTimeout(r,500));
const result = await send('Runtime.evaluate',{expression:`chrome.developerPrivate.getExtensionInfo('ifkjnimbijeafkmehbhchmamkpnhphac').then(i=>({state:i.state,disableReasons:i.disableReasons,
  path:i.path,manifestErrors:i.manifestErrors,runtimeErrors:(i.runtimeErrors||[]).map(e=>({id:e.id,message:e.message,contextUrl:e.contextUrl})),views:i.views}))`,awaitPromise:true,returnByValue:true},sessionId);
if(process.argv.includes('--clear-harness-errors')){
  const ids=result.result.value.runtimeErrors.map(error=>error.id);
  if(ids.length)await send('Runtime.evaluate',{expression:`chrome.developerPrivate.deleteExtensionErrors({extensionId:'ifkjnimbijeafkmehbhchmamkpnhphac',errorIds:${JSON.stringify(ids)}}).then(()=>true)`,awaitPromise:true,returnByValue:true},sessionId);
}
const targets=(await send('Target.getTargets')).targetInfos.map(t=>({id:t.targetId,url:t.url,type:t.type,attached:t.attached}));
const probes=[];
let schedulerProbe;
if(process.argv.includes('--scheduler-probe')){
  const worker=targets.find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://ifkjnimbijeafkmehbhchmamkpnhphac/'));
  if(worker){
    const {sessionId:workerSession}=await send('Target.attachToTarget',{targetId:worker.id,flatten:true});
    const value=await send('Runtime.evaluate',{expression:`(async()=>{const source=LaterOnQuickSearch.yieldTask;globalThis.__yieldProbe={calls:0,finished:0,tasks:[]};
      LaterOnQuickSearch.yieldTask=function(){__yieldProbe.calls++;const result=source();return Promise.resolve(result).then(v=>{__yieldProbe.finished++;return v;});};
      const p=performance.now();for(const priority of ['background','user-visible','user-blocking']) scheduler.postTask(()=>__yieldProbe.tasks.push({priority,ms:performance.now()-p}),{priority});
      await new Promise(r=>setTimeout(r,1500));return {probe:__yieldProbe,interactive:LaterOnQuickSwitcher.isInteractive(),book:await LaterOnLocalIndex.info('bookmarks')};})()`,awaitPromise:true,returnByValue:true},workerSession);
    schedulerProbe=value.exceptionDetails||value.result.value;await send('Target.detachFromTarget',{sessionId:workerSession});
  }
}
for(const file of ['native-modes-harness.html']){
  const {targetId:probeId}=await send('Target.createTarget',{url:'chrome-extension://ifkjnimbijeafkmehbhchmamkpnhphac/'+file,background:false});
  const {sessionId:probeSession}=await send('Target.attachToTarget',{targetId:probeId,flatten:true});
  await new Promise(r=>setTimeout(r,250));
  const probe=await send('Runtime.evaluate',{expression:'({url:location.href,title:document.title,body:document.body?.innerText.slice(0,1000),ready:document.readyState,chrome:typeof chrome?.runtime})',returnByValue:true},probeSession);
  const state=await send('Runtime.evaluate',{expression:`(async()=>({stored:await chrome.storage.local.get(['laterOnBookmarkStateMeta','laterOnQuickSearchPending','laterOnBookmarkConfig']),
    indexes:await Promise.all(['search','bookmarks'].map(k=>LaterOnLocalIndex.info(k).then(m=>m&&Object.fromEntries(Object.entries(m).filter(([k])=>k!=='omittedPostings'))))),
    health:await chrome.runtime.sendMessage({type:'QUICK_SWITCHER_SEARCH',query:'zznonexistent8nqv',modeId:'mode2'}).then(r=>({ok:r?.ok,total:r?.total,provisional:r?.provisional,cancelled:r?.cancelled,error:r?.error}),e=>({error:e.message}))}))()`,awaitPromise:true,returnByValue:true},probeSession);
  let restoreReadback;
  if(process.argv.includes('--restore-check')){
    const value=await send('Runtime.evaluate',{expression:`(async()=>{const all=await chrome.storage.local.get(['laterOnItems','laterOnProjects','laterOnSettings','laterOnBookmarkConfig']);
      const tree=await chrome.bookmarks.getTree(),stack=[...tree];let pages=0,fixturePresent=false;
      while(stack.length){const n=stack.pop();if(n.url)pages++;if(n.id==='50840'||n.title==='Native modes fixture')fixturePresent=true;if(n.children)stack.push(...n.children);}
      return {items:all.laterOnItems?.length,projects:all.laterOnProjects?.length,bookmarkPages:pages,fixtureFolderAbsent:!fixturePresent,
        readingFixtureAbsent:!(all.laterOnItems||[]).some(i=>String(i.id).startsWith('native-modes-')),
        projectFixtureAbsent:!(all.laterOnProjects||[]).some(p=>p.id==='native-modes-project'),settings:all.laterOnSettings,bookmarkConfig:all.laterOnBookmarkConfig};})()`,awaitPromise:true,returnByValue:true},probeSession);
    restoreReadback=value.exceptionDetails||value.result.value;
  }
  probes.push({file,result:probe.exceptionDetails||probe.result.value,state:state.exceptionDetails||state.result.value,restoreReadback});await send('Target.closeTarget',{targetId:probeId});
}
let newRuntimeErrors;
if(process.argv.includes('--clear-harness-errors')){
  const errors=await send('Runtime.evaluate',{expression:`chrome.developerPrivate.getExtensionInfo('ifkjnimbijeafkmehbhchmamkpnhphac').then(i=>(i.runtimeErrors||[]).map(e=>({message:e.message,contextUrl:e.contextUrl})))`,awaitPromise:true,returnByValue:true},sessionId);
  newRuntimeErrors=errors.exceptionDetails||errors.result.value;
}
const output={extension:result.exceptionDetails||result.result.value,targets,probes,schedulerProbe,newRuntimeErrors};
fs.writeFileSync('/private/tmp/lateron-instant-native-work/modes-diagnosis-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
await send('Target.closeTarget',{targetId});socket.close();process.exit(0);

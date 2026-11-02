// Offline fixture: real UI and sync modules, synthetic previews and isolated native APIs.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || '/private/tmp/lateron-library-redesign');
fs.mkdirSync(OUT, { recursive: true });
for (const name of fs.readdirSync(ROOT)) if (/\.(js|css|png)$/.test(name)) fs.copyFileSync(path.join(ROOT, name), path.join(OUT, name));
function cover(tone) {
  const width=640,height=400,raw=Buffer.alloc((width*3+1)*height), shades=[[229,145,94],[98,139,167],[104,151,125],[172,145,101]];
  const accent=shades[tone%shades.length];
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    let color=[247,246,242];
    if(y<34) color=accent;
    else if(x<90) color=[232,231,224];
    else if(x>112&&x<616&&y>58&&y<204) color=accent.map(value=>Math.min(255,value+Math.round((x-112)/20)));
    else if(y>224&&y<237&&x>114&&x<446) color=[65,68,67];
    else if(y>252&&y<262&&x>114&&x<600 || y>276&&y<286&&x>114&&x<535) color=[191,194,187];
    else if(y>320&&y<375&&x>114&&x<605) color=x%163<144?accent.map(value=>Math.min(255,value+55)):[247,246,242];
    const offset=y*(width*3+1)+1+x*3;for(let c=0;c<3;c++) raw[offset+c]=color[c];
  }
  function crc(buffer){let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}
  function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,sum]);}
  const head=Buffer.alloc(13);head.writeUInt32BE(width,0);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const images=Array.from({length:4},(_,i)=>cover(i));
const fixture = function(images) {
  window.fixtureErrors=[];addEventListener('error',event=>fixtureErrors.push(event.message));addEventListener('unhandledrejection',event=>fixtureErrors.push(String(event.reason)));
  const params=new URL(location.href).searchParams;
  const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn)},hasListener(fn){return this.listeners.includes(fn)},removeListener(fn){this.listeners=this.listeners.filter(item=>item!==fn)},emit(...args){this.listeners.forEach(fn=>fn(...args))}});
  const nodes=[{id:'0',title:''},{id:'1',parentId:'0',title:'书签栏',folderType:'bookmarks-bar'},{id:'2',parentId:'0',title:'其他书签',folderType:'other'},
    {id:'research',parentId:'1',title:'博士研究'},{id:'methods',parentId:'research',title:'研究方法与技术路线'},{id:'papers',parentId:'methods',title:'理论基础与参考文献'},
    {id:'tools',parentId:'1',title:'常用工具'},{id:'design',parentId:'2',title:'界面与设计参考'},{id:'long-folder',parentId:'design',title:'用于检查中文长名称与 gyqp descenders 完整显示的子文件夹'}];
  const titles=['如何把阅读中的问题转化为可验证的研究假设','从文献整理到研究设计：一个可以持续迭代的工作流','这是一条用于检查中文多行标题不会被行高截断的完整网页标题 gyqp','模型评估与可复现研究的实践方法','Designing useful interfaces for long-term knowledge collections','一份长期使用的研究工具清单','信息整理中的分类、层级与再发现','让网页回到它应该在的位置'];
  const parents=['research','research','research','methods','papers','tools','design','long-folder'];
  titles.forEach((title,i)=>nodes.push({id:'page-'+i,parentId:parents[i],title,url:'https://example.com/fixture/'+i,dateAdded:Date.now()-i*86400000}));
  window.fixtureNodes=nodes;
  window.fixtureStore={laterOnSettings:{language:params.get('language')==='en'?'en':'zh-CN',theme:params.get('theme')==='dark'?'dark':'light'},laterOnBookmarkConfig:{enabled:true,scopeId:null},laterOnItems:[],laterOnCovers:{}};
  nodes.filter(node=>node.url).forEach((node,i)=>{if(i===5)return;fixtureStore.laterOnItems.push({id:'r-'+i,url:node.url,title:node.title,image:'local://r-'+i,description:'用于离线界面验收的示例摘要。封面是合成网页预览，不会请求真实网站或改动个人书签。'});fixtureStore.laterOnCovers['r-'+i]=images[i%images.length];});
  let next=100;
  const native=Object.fromEntries(['onCreated','onRemoved','onChanged','onMoved','onChildrenReordered','onImportBegan','onImportEnded'].map(name=>[name,event()]));
  native.getTree=async()=>{const all=structuredClone(nodes),byId=new Map(all.map(node=>[node.id,node]));all.forEach(node=>{if(!node.url)node.children=[]});all.forEach(node=>{if(node.parentId)byId.get(node.parentId)?.children.push(node)});return[byId.get('0')]};
  native.create=async data=>{const node={id:String(next++),...data};nodes.push(node);native.onCreated.emit(node.id,node);return node};
  native.update=async(id,patch)=>{const node=nodes.find(node=>node.id===id);Object.assign(node,patch);native.onChanged.emit(id,patch);return node};
  native.move=async(id,patch)=>{const node=nodes.find(node=>node.id===id);Object.assign(node,patch);native.onMoved.emit(id,patch);return node};
  native.remove=async id=>{const node=nodes.find(node=>node.id===id);if(nodes.some(node=>node.parentId===id))throw Error('Not empty');nodes.splice(nodes.indexOf(node),1);native.onRemoved.emit(id,{node})};
  const changes=event();
  window.chrome={bookmarks:native,permissions:{async contains(){return true},async request(){return true},onAdded:event(),onRemoved:event()},storage:{local:{async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(key=>key in fixtureStore).map(key=>[key,structuredClone(fixtureStore[key])]))},async set(patch){Object.assign(fixtureStore,structuredClone(patch));changes.emit(Object.fromEntries(Object.entries(patch).map(([key,value])=>[key,{newValue:value}])),'local')}},onChanged:changes},runtime:{onMessage:event(),onStartup:event(),onInstalled:event(),getURL:p=>new URL(p,location.href).href,async sendMessage(message){try{return{ok:true,state:await LaterOnBookmarkSync.handle(message)}}catch(error){return{ok:false,error:error.message}}}},alarms:{create(){},clear(){},onAlarm:event()}};
  window.fetch=async url=>String(url).endsWith('.png')?new Response(Uint8Array.from(atob(images[0].split(',')[1]),char=>char.charCodeAt(0)),{headers:{'content-type':'image/png'}}):new Response('<meta name="description" content="Offline preview fixture"><meta property="og:image" content="https://images.example.test/preview.png">',{headers:{'content-type':'text/html'}});
};
fs.writeFileSync(path.join(OUT,'fixture.js'),`(${fixture.toString()})(${JSON.stringify(images)});`);
let html=fs.readFileSync(path.join(ROOT,'bookmarks.html'),'utf8');
html=html.replace('<script src="theme.js"></script>','<script src="fixture.js"></script><script src="bookmark-previews.js"></script><script src="bookmark-sync.js"></script><script src="theme.js"></script>');
fs.writeFileSync(path.join(OUT,'bookmarks.html'),html);
execFileSync(process.execPath,[path.join(__dirname,'build-board-preview.js')],{cwd:ROOT});
fs.copyFileSync(path.join(__dirname,'board-preview.html'),path.join(OUT,'library.html'));
console.log(path.join(OUT,'bookmarks.html'));

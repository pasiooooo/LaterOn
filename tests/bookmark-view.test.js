const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const dom = new JSDOM('<!doctype html><body><div id="tree"></div><div id="crumbs"></div><div id="boards"></div><div id="pages"></div></body>', {runScripts:'outside-only'});
try {
  const { window } = dom;
  window.eval(fs.readFileSync(path.join(root, 'url-utils.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'bookmark-view.js'), 'utf8'));
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const nodes = [
    {id:'root',parentId:'0',title:'Bookmarks bar'},
    {id:'work',parentId:'root',title:'研究资料与长期保存的参考文献'},
    {id:'deep',parentId:'work',title:'Nested papers'},
    {id:'page',parentId:'deep',title:'中文长标题和带有 descenders gyqp 的完整标题',url:'https://paper.test/',preview:{image,description:'A useful abstract'}},
    {id:'other',parentId:'root',title:'Other page',url:'https://other.test/'}
  ];
  const model = window.LaterOnBookmarkView.index(nodes);
  assert.deepEqual(Array.from(model.trail('deep'), node => node.id), ['root','work','deep']);
  assert.equal(model.summary('root').pages, 2);
  assert.equal(model.summary('work').pages, 1);
  assert.equal(model.summary('work').previews[0].preview.image, image);
  const late = window.LaterOnBookmarkView.index([{id:'folder',parentId:'0',title:'Folder'},
    ...Array.from({length:8},(_,i)=>({id:`l${i}`,parentId:'folder',url:`https://example.test/${i}`,title:`Page ${i}`,...(i===7?{preview:{image}}:{})}))]);
  assert.equal(late.summary('folder').previews[0].id,'l7','Folder mosaics prefer available covers even beyond the first three descendants');
  assert.deepEqual(Array.from(model.pages('work', true), node => node.id), ['page']);
  assert.equal(model.pages('work', false).length, 0);
  assert.deepEqual(Array.from(window.LaterOnBookmarkView.index(nodes.slice(1,4), 'work').roots, node => node.id), ['work'], 'Scoped folders become roots without revealing native parents');
  const actions = [];
  const view = window.LaterOnBookmarkView.create({
    tree: window.document.querySelector('#tree'), breadcrumbs:window.document.querySelector('#crumbs'), boards:window.document.querySelector('#boards'), list:window.document.querySelector('#pages'),
    t:(key, params={}) => key + (params.n == null ? '' : ` ${params.n}`),
    onNavigate:id=>actions.push(['navigate',id]), onToggle:id=>actions.push(['toggle',id]), onEdit:()=>{},onMove:()=>{},onRemove:()=>{}
  });
  view.render({nodes,scopeId:null,selected:'work',expanded:new Set(['root','work']),query:'',limit:48});
  assert(window.document.querySelector('[data-folder-id="deep"]'));
  assert(window.document.querySelector('[data-folder-id="work"] ul'), 'Hierarchy is represented by actual nested groups');
  assert.equal(window.document.querySelectorAll('.bookmark-folder-card').length, 1);
  assert.equal(window.document.querySelector('.bookmark-folder-card img').src, image, 'Folder boards preview descendant pages, not only immediate children');
  assert.equal(window.document.querySelectorAll('.bookmark-card').length, 0);
  view.render({nodes,scopeId:null,selected:'work',expanded:new Set(['root']),query:'中文',limit:48});
  assert.equal(window.document.querySelectorAll('.bookmark-card').length, 1, 'Folder searches include descendants');
  assert.equal(window.document.querySelector('.bookmark-card .cover img').src, image);
  assert.equal(window.document.querySelector('.bookmark-card h2').textContent, nodes[3].title);
  window.document.querySelector('.bookmark-breadcrumb:last-child').click();
  assert.deepEqual(actions.at(-1), ['navigate','work']);
  const many = [...nodes, ...Array.from({length:80}, (_,i)=>({id:`p${i}`,parentId:'root',url:`https://example.test/${i}`,title:`Page ${i}`}))];
  const result = view.render({nodes:many,selected:'',expanded:new Set(),query:'',limit:12});
  assert.equal(window.document.querySelectorAll('.bookmark-card').length, 12);
  assert.equal(result.totalPages, 82);
  assert.equal(window.document.querySelectorAll('.bookmark-folder-card').length, 1);
  assert.equal(window.document.querySelectorAll('[data-setting="autoCleanDays"],.read-toggle').length, 0);
  const search = { id: 'search', parentId: 'root', title: 'Search Results', url: 'https://www.google.com/search?q=reading+workflow' };
  view.render({ nodes: [...nodes, search], selected: '', query: 'reading workflow' });
  assert.equal(window.document.querySelector('.bookmark-card h2').textContent, 'reading workflow - Google', 'Existing search bookmarks show and match their decoded query');
  assert.equal(search.title, 'Search Results', 'Presentation does not mutate the authoritative native bookmark title');
  const named = { ...search, id: 'named-search', title: '论文检索入口' };
  for (const query of ['论文检索入口', 'reading workflow']) {
    view.render({ nodes: [...nodes, named], selected: '', query });
    assert.equal(window.document.querySelector('.bookmark-card h2').textContent, '论文检索入口', 'Meaningful native names remain visible and searchable alongside the decoded query');
  }
  for (const title of ['Search Results', 'Search', '搜索结果', '搜索', 'Google', 'Google Search', 'Search Results - Google', search.url]) {
    view.render({ nodes: [...nodes, { ...search, title }], selected: '', query: 'reading workflow' });
    assert.equal(window.document.querySelector('.bookmark-card h2').textContent, 'reading workflow - Google', `Repair only weak search titles: ${title}`);
  }
  view.render({ nodes: [...nodes, { ...search, title: 'Google Scholar 文献查新' }], selected: '', query: 'reading workflow' });
  assert.equal(window.document.querySelector('.bookmark-card h2').textContent, 'Google Scholar 文献查新', 'A name containing the engine label remains meaningful');
  console.log('PASS bookmark view: nested hierarchy, scoped roots, descendant mosaics/search, breadcrumb navigation, page cards and independent pagination');
} finally { dom.window.close(); }

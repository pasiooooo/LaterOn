const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const context = vm.createContext({ URL });
for (const file of ['url-utils.js', 'quick-switcher-search.js']) vm.runInContext(read(file), context);
const { build, search } = context.LaterOnQuickSearch;
const ids = result => Array.from(result.results, entry => entry.url);
const item = (id, title, url, extra = {}) => ({ id, title, url, savedAt: 1, ...extra });
const state = nodes => ({ enabled: true, scopeId: null, nodes });
const config = { enabled: true, scopeId: null };

const input = { items: [
  item('old', '阅读工作流', 'https://example.com/paper', { projectId: 'archived', status: 'done', image: 'data:image/png;base64,LARGE', description: 'Do not duplicate this payload' }),
  item('new', 'Obsidian notes', 'https://notes.test/', { savedAt: 100 }),
  item('unfiled', '无项目页面', 'https://inbox.test/', { savedAt: 90 }),
  item('anchor', '第二节', 'https://example.com/paper#two'),
  item('unsafe', 'Unsafe', 'javascript:alert(1)'),
  item('credentials', 'Credentials', 'https://:secret@example.com/')
], projects: [{ id: 'archived', name: '博士研究', archived: true }], bookmarkConfig: config,
bookmarks: state([{ id: 'root', title: '书签栏' }, { id: 'research', parentId: 'root', title: '文献方法' },
  { id: 'first', parentId: 'research', title: '长期研究入口', url: 'https://example.com/paper', dateAdded: 10 },
  { id: 'second', parentId: 'root', title: '另一份收藏', url: 'https://example.com/paper', dateAdded: 20 }]) };
const original = JSON.stringify(input), index = build(input), merged = index.find(entry => entry.url === 'https://example.com/paper');
assert.equal(index.length, 4, 'Duplicate URLs merge while anchors stay separate and unsafe schemes/userinfo are excluded');
assert.equal(merged.title, '长期研究入口', 'A meaningful native bookmark name can identify a merged page');
assert.deepEqual(Array.from(merged.readingIds), ['old']);
assert.deepEqual(Array.from(merged.bookmarkIds), ['first', 'second']);
assert.deepEqual(Array.from(merged.projectNames), ['博士研究']);
assert.deepEqual(Array.from(merged.folderNames), ['书签栏 / 文献方法', '书签栏']);
assert.equal(merged.savedAt, 20);
assert(!('image' in merged) && !('description' in merged) && !('preview' in merged), 'The search index has no cover or body payload');
assert.equal(JSON.stringify(input), original, 'Building the index does not modify persisted input');
assert.equal(search(index, '博士 方法').results[0].url, merged.url, 'Multiword Chinese search can match project and bookmark ancestry together');
assert.equal(search(index, '阅读 工作流').results[0].url, merged.url, 'Merged title aliases remain searchable');
assert.equal(search(index, 'obsdn').results[0].title, 'Obsidian notes', 'Conservative Latin subsequence matching supports compact names');
assert.equal(search(index, 'od').total, 0, 'Two-letter queries are not fuzzily expanded');
assert.equal(search(index, '等待整理').total, 3, 'Unfiled reading pages are discoverable by the inbox name');
assert.equal(search(index, 'INBOX').total, 3, 'Inbox metadata has an English alias');
assert.equal(search(index, '').results[0].url, 'https://notes.test/', 'Empty-query order shows recent pages first');
assert.equal(search(index, 'not present at all').total, 0);
assert.equal(search(index, '研究', { limit: 0 }).results.length, 0);
assert.equal(search(index, '研究', { limit: 0 }).total, 1);
const clone = JSON.parse(JSON.stringify(index));
assert.equal(search(clone, '阅读 工作流').results[0].url, merged.url, 'Lean indexes remain searchable after a runtime message round trip');

for (const override of [
  { bookmarkConfig: { enabled: false } },
  { bookmarks: { ...input.bookmarks, enabled: false } },
  { bookmarks: { ...input.bookmarks, error: 'bookmarkPermission' } },
  { bookmarks: { ...input.bookmarks, scopeId: 'research' } },
  { bookmarkConfig: {} }
]) assert(build({ ...input, ...override }).every(entry => !entry.bookmarkIds.length), 'Unavailable or mismatched-scope cache never leaks into results');
const scoped = build({ bookmarkConfig: { enabled: true, scopeId: 'scope' }, bookmarks: { enabled: true, scopeId: 'scope',
  folders: [{ id: 'root', title: 'Root' }, { id: 'scope', parentId: 'root', title: 'Scope' }], nodes: [
    { id: 'inside', parentId: 'scope', title: 'Inside', url: 'https://inside.test/' },
    { id: 'outside', parentId: 'root', title: 'Outside', url: 'https://outside.test/' },
    { id: 'loop', parentId: 'loop', title: 'Loop' },
    { id: 'cycled', parentId: 'loop', title: 'Cycle', url: 'https://cycle.test/' }
  ] } });
assert.deepEqual(Array.from(scoped, entry => entry.url), ['https://inside.test/'], 'Native ancestry enforces the selected scope even with malformed cycles');

const searchUrl = 'https://google.com/search?q=%E9%87%8F%E5%AD%90';
const searchPages = build({ items: [item('query', 'Search Results', searchUrl),
  item('edited', '我的检索入口', `${searchUrl}&page=2`, { titleEdited: true })], bookmarkConfig: config,
  bookmarks: state([{ id: 'named', title: '专门的检索书签', url: `${searchUrl}&page=3` },
    { id: 'generic', title: 'Search Results - Google', url: `${searchUrl}&page=4` }]) });
assert.equal(searchPages.find(entry => entry.url === searchUrl).title, '量子 - Google');
assert.equal(searchPages.find(entry => entry.readingIds.includes('edited')).title, '我的检索入口');
assert.equal(searchPages.find(entry => entry.bookmarkIds.includes('named')).title, '专门的检索书签');
assert.equal(searchPages.find(entry => entry.bookmarkIds.includes('generic')).title, '量子 - Google');
assert.equal(search(searchPages, '量子').total, 4, 'Actual search queries remain discoverable even with custom titles');
assert.equal(searchPages.length, 4, 'Distinct query parameters are never merged');

const ranked = build({ items: [item('url', 'Other page', 'https://reader.test/', { savedAt: 500 }),
  item('location', 'Notes', 'https://notes.test/', { savedAt: 400, projectId: 'reader' }),
  item('prefix', 'Reader tips', 'https://tips.test/', { savedAt: 300 }),
  item('exact', 'Reader', 'https://exact.test/', { savedAt: 1 }),
  item('accent', 'Café Résumé', 'https://accent.test/', { savedAt: 2 })], projects: [{ id: 'reader', name: 'Reader' }] });
assert.deepEqual(ids(search(ranked, 'reader')), ['https://exact.test/', 'https://tips.test/', 'https://notes.test/', 'https://reader.test/'], 'Exact and prefix titles outrank newer location and URL hits');
assert.equal(search(ranked, 'CAFE resume').results[0].title, 'Café Résumé', 'Matching is case and accent insensitive');
assert.equal(search(ranked, 'caf rsm').results[0].title, 'Café Résumé');

const large = build({ items: Array.from({ length: 10000 }, (_, i) => item(`item-${i}`, `科研资料 ${i}`, `https://example.test/article/${i}`, { savedAt: i })) });
const many = search(large, '科研 资料');
assert.equal(many.total, 10000);
assert.equal(many.results.length, 50, 'Only a bounded set is returned while all stored pages participate in matching');
assert.equal(many.results[0].url, 'https://example.test/article/9999');
assert.equal(search(large, 'article/4321').results[0].url, 'https://example.test/article/4321');
assert.equal(search(large, '', { limit: 5000 }).results.length, 100, 'Caller limits cannot produce an unbounded DOM payload');
assert.equal(search([], 'anything').total, 0);
assert.equal(build({ items: null, projects: null, bookmarks: null, bookmarkConfig: null }).length, 0);
const readingOnly = build({ ...input, sources: ['reading'] });
const bookOnly = build({ ...input, sources: ['bookmarks'] });
assert(readingOnly.every(entry => !entry.bookmarkIds.length && !entry.folderNames.length));
assert(bookOnly.every(entry => !entry.readingIds.length && !entry.projectNames.length));
assert.equal(search(bookOnly, '博士').total, 0, 'Book-only never borrows Reading project terms');
assert.equal(search(bookOnly, '阅读 工作流').total, 0, 'Book-only never borrows a Reading title alias');
assert.equal(search(readingOnly, '长期研究入口').total, 0, 'Reading-only never borrows native bookmark titles');
const liveTabs = context.LaterOnQuickSearch.buildTabs([
  { id: 2, url: 'https://example.com/paper', title: 'NativeToken', lastAccessed: 20, projectNames: ['Not native data'] },
  { id: 3, url: 'https://example.com/paper', title: 'Another native title', lastAccessed: 10 },
  { id: 4, url: 'chrome://settings/', title: 'Settings', lastAccessed: 1 },
  { id: -1, url: 'https://invalid.test/', title: 'No native id' }
]);
assert.equal(liveTabs.length, 2); assert.deepEqual(Array.from(liveTabs[0].tabIds), [2, 3]);
assert.equal(search(liveTabs, 'Not native data').total, 0, 'Tabs-only matches native titles/URLs, not injected library-shaped fields');
assert.equal(search(liveTabs, 'Settings').results[0].url, 'chrome://settings/', 'Protected native tabs remain searchable');
const lookup = [{ entry: readingOnly.find(entry => entry.url === 'https://example.com/paper'), libraryScore: null }];
const joined = context.LaterOnQuickSearch.mergeTabs(liveTabs, lookup, ['tabs', 'reading']);
assert.equal(context.LaterOnQuickSearch.matchAll(joined, 'NativeToken 博士').length, 1, 'A URL can match across its selected native and Reading fields');
assert.equal(joined[0].title, lookup[0].entry.title, 'Library title stays visible while native aliases participate in search');
console.log('PASS quick-switcher search: cross-library deduplication, scopes, all reading states, CJK/Latin ranking, title preservation, lean serialization and 10,000-page bounds');

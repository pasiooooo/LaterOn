const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(read('url-utils.js'), context);
vm.runInContext(read('page-metadata.js'), context);
const title = context.LaterOnUrl.searchTitle;
const cases = [
  ['https://www.google.com/search?q=quantum+computing&sourceid=chrome', 'quantum computing - Google'],
  ['https://www.google.com.hk/search?q=%E6%96%87%E7%8C%AE+%E7%AE%A1%E7%90%86&udm=2', '文献 管理 - Google'],
  ['https://www.google.co.uk/search?q=C%2B%2B+%26+Rust', 'C++ & Rust - Google'],
  ['https://www.google.com/webhp?q=biomaterials', 'biomaterials - Google'],
  ['https://www.bing.com/search?q=browser+extensions', 'browser extensions - Bing'],
  ['https://cn.bing.com/search?q=%E8%AF%BB%E4%B9%A6', '读书 - Bing'],
  ['https://www.baidu.com/s?wd=%E7%A7%91%E7%A0%94', '科研 - 百度'],
  ['https://m.baidu.com/s?word=notes', 'notes - 百度'],
  ['https://duckduckgo.com/?q=privacy', 'privacy - DuckDuckGo'],
  ['https://html.duckduckgo.com/html/?q=web+search', 'web search - DuckDuckGo'],
  ['https://search.yahoo.com/search?p=web+search', 'web search - Yahoo'],
  ['https://www.sogou.com/web?query=browser', 'browser - 搜狗'],
  ['https://www.so.com/s?q=browser', 'browser - 360搜索'],
  ['https://search.brave.com/search?q=browser', 'browser - Brave Search'],
  ['https://yandex.com/search/?text=browser', 'browser - Yandex'],
  ['https://www.startpage.com/sp/search?query=browser', 'browser - Startpage'],
  ['https://www.google.com/search?q=%20%0A%00%20research%09%20tools%20', 'research tools - Google']
];
for (const [url, expected] of cases) assert.equal(title(url), expected, url);
for (const url of [
  'https://www.google.com/search?q=%20%20', 'https://www.google.com/search',
  'https://example.com/search?q=browser', 'https://google.evil.com/search?q=browser',
  'https://www.google.com.evil.test/search?q=browser', 'https://www.google.com/preferences?q=browser',
  'https://www.bing.com/images/detail?q=browser', 'https://www.baidu.com/link?wd=browser',
  'https://search.yahoo.com.evil.test/search?p=browser', 'ftp://google.com/search?q=browser', 'invalid'
]) assert.equal(title(url), '', url);
assert(title(`https://google.com/search?q=${'a'.repeat(2000)}`).length <= 300, 'Oversized queries stay within metadata title bounds');

const html = '<title>Wrong previous query - Google</title><meta property="og:title" content="Search Results"><meta property="og:site_name" content="Google"><main><h1>Search Results</h1><h2>Unrelated result headline</h2></main>';
for (const [url, expected] of cases) {
  assert.equal(context.LaterOnPageMetadata.parse(html, url).title, expected, 'Static imports/rescue use the query');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.eval(read('url-utils.js'));
  const metadata = dom.window.eval(read('content-metadata.js'));
  assert.equal(metadata.title, expected, 'Loaded-page extraction ignores generic/stale metadata');
  assert.equal(metadata.titleFrom, 'search-query');
  dom.window.close();
}
assert.equal(context.LaterOnPageMetadata.parse('<title>Ordinary article</title>', 'https://example.com/search?q=article').title, 'Ordinary article');

// Injection failure, sleeping tabs and cached current-page callers still receive
// a query title even if there is no readable DOM and server rescue is disabled.
const background = read('background.js');
const extract = background.match(/^async function extractTabMetadata\([^]*?^}/m)[0];
const fallbackContext = vm.createContext({ URL, Date, LaterOnUrl: context.LaterOnUrl,
  safeHostname: value => new URL(value).hostname, isDouyinUrl: () => false,
  readTabMetadata: async () => null, refetchMetaFromServer: async () => null, DOUYIN_SETTLE_MS: 1000 });
vm.runInContext(extract, fallbackContext);
(async () => {
  const tab = { id: 1, url: cases[0][0], title: 'Search Results', discarded: true };
  assert.equal((await fallbackContext.extractTabMetadata(tab, { serverRescue: false })).title, cases[0][1]);
  assert.equal((await fallbackContext.extractTabMetadata({ ...tab, discarded: false }, { serverRescue: false })).title, cases[0][1]);
  console.log('PASS search titles: recognized result URLs, encoded queries, stale sharing metadata, imports and DOM-unavailable fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });

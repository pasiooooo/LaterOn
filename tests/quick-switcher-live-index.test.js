// Integration against actual library transactions: native URLs outside the
// first library page still deduplicate and carry their source projections.
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const { fixture } = require('./quick-switcher-live-tabs.test.js');
const plain = value => JSON.parse(JSON.stringify(value));
(async () => {
  const w = fixture(new IDBFactory()), index = w.context.LaterOnLocalIndex;
  await index.putSearchSource(plain(w.store), 1);
  const metadata = await index.info();
  const common = await w.search('Common');
  assert.equal(common.provisional, undefined);
  assert.equal(common.total, 261); assert.equal(common.results.length, 50, 'A broad match is filtered, merged and bounded');
  const joined = await w.search('NativeToken ProjectMarker');
  assert.equal(joined.total, 1); assert.equal(joined.results[0].title, 'Reading edited Common');
  assert.deepEqual(plain(joined.results[0].readingIds), ['r0']); assert.deepEqual(plain(joined.results[0].bookmarkIds), ['bookmark']);
  assert.deepEqual(plain(joined.results[0].tabIds), [2]);
  assert.equal((await w.search('Reading edited', 'mode3')).total, 0);
  assert.equal((await w.search('ProjectMarker', 'mode3')).total, 0);
  assert.equal((await w.search('BookmarkDistinct', 'mode3')).total, 1);
  assert.equal((await w.search('NativeToken', 'mode2')).total, 0);
  w.modes(['reading']); w.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 2 });
  const after = await index.info();
  assert.equal(after.generation, metadata.generation); assert.equal(after.revision, metadata.revision);
  assert.equal(after.pending, metadata.pending, 'Mode/native events do not claim or rebuild a persistent generation');
  const read = (await w.search('Reading edited')).results[0]; await w.open(read.id, 'default', true);
  assert.equal(w.counts.creates.at(-1).url, 'https://shared.test/paper?q=kept#section');
  // The shared library URL comes after over 1,000 native URLs, and outside
  // the library's top50. No fixed lookup prefix may lose its source fields
  // or count the same page once per library and once per native session.
  w.modes(['tabs', 'reading', 'bookmarks']);
  const sharedTab = w.tabs.find(tab => tab.id === 2); sharedTab.lastAccessed = 0;
  w.chrome.tabs.onUpdated.emit(2, { title: sharedTab.title }, plain(sharedTab));
  for (let i = 0; i < 1005; i++) {
    const tab = { id: 2000 + i, windowId: 20, url: `https://large-native.test/${i}`, title: `Large native ${i}`, lastAccessed: 10000 + i };
    w.tabs.push(tab); w.chrome.tabs.onCreated.emit(plain(tab));
  }
  const farJoined = await w.search('NativeToken ProjectMarker');
  assert.equal(farJoined.total, 1, 'All native URLs receive same-snapshot library lookup, including those beyond 1,000');
  assert.equal(farJoined.results[0].title, 'Reading edited Common');
  assert.deepEqual(plain(farJoined.results[0].readingIds), ['r0']); assert.deepEqual(plain(farJoined.results[0].bookmarkIds), ['bookmark']);
  assert.equal((await w.search()).total, 1268, 'The shared URL beyond both result prefixes counts once in the complete union');
  assert.equal((await index.info()).generation, metadata.generation, 'Large native-session changes never rebuild the library generation');
  const cancelledWorker = fixture(new IDBFactory()), cancelledIndex = cancelledWorker.context.LaterOnLocalIndex;
  await cancelledIndex.putSearchSource(plain(cancelledWorker.store), 1);
  const beforeCancel = await cancelledIndex.info(), originalSearch = cancelledIndex.search;
  let release, reach, returnedNull = false;
  const held = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { reach = resolve; });
  cancelledIndex.search = async (query, context, options) => {
    if (query === 'Common') { reach(); await held; }
    const result = await originalSearch(query, context, options);
    if (query === 'Common') returnedNull = result === null;
    return result;
  };
  const oldQuery = cancelledWorker.search('Common', 'mode2'); await reached;
  assert.equal((await cancelledWorker.search('Settings', 'mode1')).total, 1); release();
  assert.equal((await oldQuery).cancelled, true); assert.equal(returnedNull, true, 'The real Index reports cancellation with null');
  await new Promise(resolve => setTimeout(resolve, 350));
  const afterCancel = await cancelledIndex.info();
  assert.equal(afterCancel.generation, beforeCancel.generation, 'A cancelled query never forces a new persistent generation');
  assert.equal(afterCancel.revision, beforeCancel.revision, 'A cancelled query leaves the source revision unchanged');
  assert.deepEqual(cancelledWorker.counts.writes, [], 'Cancelling a query neither writes nor clears a Chrome pending marker');
  assert.equal(cancelledWorker.store.laterOnQuickSearchPending, undefined);
  console.log('PASS live tabs + real fake-indexeddb: snapshot URL supplements, exact totals, source fields, cross-source terms, independent generations and exact opening');
})().catch(error => { console.error(error); process.exitCode = 1; });

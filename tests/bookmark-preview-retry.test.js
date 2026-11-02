const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const fixture = require('./bookmark-sync.test');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
(async () => {
  const f = fixture({ laterOnBookmarkConfig: { enabled: true, scopeId: 'scope' }, laterOnItems: [] });
  f.grant();
  let requests = 0;
  f.ctx.fetch = async () => { requests++; throw Error('Not available yet'); };
  const read = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
  const dom = new JSDOM(read('bookmarks.html'), { runScripts: 'outside-only', url: 'chrome-extension://fixture/bookmarks.html' });
  try {
    dom.window.chrome = f.chrome;
    f.chrome.runtime.sendMessage = async message => ({ ok: true, state: await f.api.handle(message) });
    for (const name of ['i18n.js', 'bookmark-view.js', 'bookmarks.js']) dom.window.eval(read(name));
    await tick();
    const button = dom.window.document.querySelector('#bookmarkLoadPreviews');
    button.click(); await tick();
    assert.equal(requests, 1);
    assert.equal(button.disabled, false, 'A user can retry immediately after opening the missing page');
    button.click(); await tick();
    assert.equal(requests, 2, 'An explicit second click performs a new bounded attempt');
  } finally { dom.window.close(); }
  console.log('PASS bookmark preview retry: failed attempts do not block explicit retries');
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const file of ['bookmarks.html', 'bookmarks.js', 'README.md']) {
  assert(!fs.readFileSync(path.join(root, file), 'utf8').includes('临时阅读'), `${file} must consistently call the reading area 阅读库`);
}
assert.match(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), /readingLibrary: "阅读库"/);
assert.match(fs.readFileSync(path.join(root, 'bookmarks.js'), 'utf8'), /reading: '阅读库'/);
console.log('PASS consistent Reading / 阅读库 and Bookmarks / 书签库 naming');

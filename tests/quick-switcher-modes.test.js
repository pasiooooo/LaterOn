const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', 'quick-switcher-modes.js'), 'utf8'), context);
const modes = context.LaterOnQuickModes;
const plain = value => JSON.parse(JSON.stringify(value));
const defaults = () => plain(modes.normalize());
assert.deepEqual(defaults(), [
  { id: 'default', prefix: '', sources: ['tabs', 'reading', 'bookmarks'] },
  { id: 'mode1', prefix: '\t', sources: ['tabs'] },
  { id: 'mode2', prefix: ' ', sources: ['reading'] },
  { id: 'mode3', prefix: "'", sources: ['bookmarks'] }
]);
assert.equal(modes.validate(defaults()).ok, true);
for (let bits = 1; bits < 8; bits++) {
  const sources = ['tabs', 'reading', 'bookmarks'].filter((_source, index) => bits & (1 << index));
  for (let index = 0; index < 4; index++) {
    const config = defaults(); config[index].sources = sources;
    assert.equal(modes.validate(config).ok, true);
    assert.deepEqual(plain(modes.get(JSON.parse(JSON.stringify(config)), config[index].id).sources), sources);
  }
}
assert.equal(modes.matchPrefix('space between words'), null, 'An ordinary internal space is query text');
for (const [query, id, remaining] of [['\talpha beta', 'mode1', 'alpha beta'], [' alpha beta', 'mode2', 'alpha beta'], ["'alpha beta", 'mode3', 'alpha beta']]) {
  const matched = modes.matchPrefix(query);
  assert.equal(matched.modeId, id); assert.equal(matched.query, remaining);
}
const custom = defaults(); custom[1].prefix = '/'; custom[2].prefix = 'r:'; custom[3].prefix = '‘';
assert.equal(modes.validate(custom).ok, true);
assert.equal(modes.matchPrefix('r:中文 多词', custom).query, '中文 多词');
assert.equal(modes.matchPrefix('‘bookmark', custom).modeId, 'mode3');
assert.equal(modes.matchPrefix('word r:query', custom), null);
const duplicate = defaults(); duplicate[3].prefix = ' ';
assert.equal(modes.validate(duplicate).ok, false);
assert(modes.validate(duplicate).errors.some(error => error.code === 'prefixConflict'));
assert.deepEqual(plain(modes.normalize(duplicate).map(row => row.prefix)), ['', '\t', ' ', "'"]);
const overlapping = defaults(); overlapping[1].prefix = 'r'; overlapping[2].prefix = 'r:';
assert.equal(modes.validate(overlapping).ok, false, 'An early trigger must not swallow another trigger');
for (const prefix of ['', '\n', '\u0085', '\u202e', '\u200b', '\u200e', '\u200f', '\u061c', '\twords', '  ', '123456789']) {
  const invalid = defaults(); invalid[1].prefix = prefix;
  assert.equal(modes.validate(invalid).ok, false, `Reject invalid prefix ${JSON.stringify(prefix)}`);
}
const empty = defaults(); empty[0].sources = [];
assert.equal(modes.validate(empty).ok, false);
assert.deepEqual(plain(modes.normalize(empty)[0].sources), ['tabs', 'reading', 'bookmarks']);
const changed = defaults(); changed[0].sources = ['bookmarks', 'tabs', 'tabs'];
assert.deepEqual(plain(modes.normalize(changed)[0].sources), ['tabs', 'bookmarks']);
assert.deepEqual(plain(modes.normalizeSources([], [])), []);
const clone = defaults(); clone[0].sources.push('fake');
assert.deepEqual(defaults()[0].sources, ['tabs', 'reading', 'bookmarks'], 'Callers cannot mutate defaults');
assert.equal(modes.get(custom, 'invalid-id').id, 'default');
assert.equal(modes.describeSources(['reading', 'tabs'], 'en'), 'Open tabs + Reading');
assert.equal(modes.describePrefix(' '), '空格');
assert.equal(modes.describePrefix('\t'), 'Tab');
console.log('PASS configurable Quick Switcher modes: defaults, all 7 source combinations, literal prefixes, conflicts, malformed settings and isolated copies');

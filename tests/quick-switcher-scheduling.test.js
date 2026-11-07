const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

(async () => {
  let clock = 0, posted = 0, messages = 0, boosted = 0;
  const context = vm.createContext({ URL, performance: { now() { clock += 7; return clock; } },
    scheduler: {
      yield() { boosted++; return Promise.resolve(); },
      postTask(task, options) {
        assert.equal(options.priority, 'background');
        posted++;
        return new Promise(resolve => setTimeout(() => { messages++; task(); resolve(); }, 0));
      }
    }
  });
  for (const name of ['url-utils.js', 'quick-switcher-search.js']) vm.runInContext(read(name), context);
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, title: `Reading ${i}`, url: `https://example.test/${i}`, savedAt: i }));
  const result = await context.LaterOnQuickSearch.buildAsync({ items });
  assert.equal(result.length, 1000);
  assert(posted > 2 && messages === posted, 'Bulk construction yields through background tasks so queued messages can run');
  assert.equal(boosted, 0, 'Bulk work never uses boosted user-visible yield continuations');
  console.log('PASS Quick maintenance scheduling: background priority tasks keep queued work runnable during construction (simulated scheduler)');
})().catch(error => { console.error(error); process.exitCode = 1; });

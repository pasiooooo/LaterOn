const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const within = (promise, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(message)), 500);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
function engine(context) {
  for (const name of ['url-utils.js', 'quick-switcher-search.js']) vm.runInContext(read(name), context);
  return context.LaterOnQuickSearch;
}
async function boundedBackgroundWait() {
  let clock = 20, reads = 0, aborted = 0, completed = 0;
  const tasks = [], timers = new Set();
  const context = vm.createContext({ URL, AbortController, performance: { now() { reads++; return clock; } },
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 32, 'Only the bounded ordinary timer backs up a queued background task');
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds); timers.add(timer); return timer;
    }, clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    scheduler: { postTask(task, options) {
      assert.equal(options.priority, 'background');
      const row = { task, signal: options.signal }; tasks.push(row);
      return new Promise((resolve, reject) => {
        row.resolve = resolve;
        options.signal.addEventListener('abort', () => { aborted++; reject(Error('cancelled background task')); }, { once: true });
      });
    } }
  });
  const quick = engine(context);
  await within(quick.yieldTask().then(() => { completed++; }), 'A background task that never executes must not stall maintenance');
  assert.equal(aborted, 1); assert.equal(tasks[0].signal.aborted, true); assert.equal(timers.size, 0);
  const settledReads = reads; clock = 50;
  tasks[0].task(); tasks[0].resolve(); await Promise.resolve();
  assert.equal(reads, settledReads, 'A late aborted task cannot move the settled CPU-budget timestamp');
  assert.equal(completed, 1, 'The fallback and late task complete one continuation');
  const next = quick.yieldTask(); assert.equal(tasks.length, 2, 'The next CPU-budget expiration still schedules a yield');
  tasks[1].task(); tasks[1].resolve(); await within(next, 'A timely background task finishes');
  assert.equal(timers.size, 0); assert.equal(tasks[1].signal.aborted, false, 'A timely task clears its timer without being aborted');
  assert.equal(aborted, 1);
  for (const failure of ['throw', 'reject']) {
    let pendingTimer = null;
    const failing = vm.createContext({ URL, AbortController, performance: { now: () => 20 },
      setTimeout(callback, delay) { return pendingTimer = setTimeout(callback, delay); },
      clearTimeout(timer) { assert.equal(timer, pendingTimer); clearTimeout(timer); pendingTimer = null; },
      scheduler: { postTask() { if (failure === 'throw') throw Error('scheduler unavailable'); return Promise.reject(Error('scheduler rejected')); } }
    });
    await within(engine(failing).yieldTask(), `A ${failure} from the scheduler must still yield successfully`);
    assert.equal(pendingTimer, null, `A scheduler ${failure} clears its fallback timer`);
  }
}

(async () => {
  let clock = 0, posted = 0, messages = 0, boosted = 0;
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout, performance: { now() { clock += 7; return clock; } },
    scheduler: {
      yield() { boosted++; return Promise.resolve(); },
      postTask(task, options) {
        assert.equal(options.priority, 'background');
        posted++;
        return new Promise(resolve => setTimeout(() => { messages++; task(); resolve(); }, 0));
      }
    }
  });
  engine(context);
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}`, title: `Reading ${i}`, url: `https://example.test/${i}`, savedAt: i }));
  const result = await context.LaterOnQuickSearch.buildAsync({ items });
  assert.equal(result.length, 1000);
  assert(posted > 2 && messages === posted, 'Bulk construction yields through background tasks so queued messages can run');
  assert.equal(boosted, 0, 'Bulk work never uses boosted user-visible yield continuations');
  await boundedBackgroundWait();
  console.log('PASS Quick maintenance scheduling: background priority, bounded timer recovery, queued task abort, late-task idempotence and scheduler failures (simulated promises/timers)');
})().catch(error => { console.error(error); process.exitCode = 1; });

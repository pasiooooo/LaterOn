const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('keyboard-shortcuts.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture({ settings, pending = false, guard = false, readError = false, statusEnabled = true, statusPending = false, focused = true, visible = 'visible' } = {}) {
  const listeners = new Map(), documentListeners = new Map(), changes = [], calls = [], statusCalls = [], gets = [], statuses = [], timers = new Map();
  let release, now = 0, timerId = 0;
  const window = { addEventListener(type, listener, capture) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push({ listener, capture });
  } };
  const document = { get visibilityState() { return visible; }, hasFocus() { return focused; }, addEventListener(type, listener) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(listener);
  } };
  const api = { runtime: { sendMessage(message) {
    if (message.type === 'QUICK_SWITCHER_LEGACY_STATUS') {
      statusCalls.push(message);
      if (statusPending) return new Promise((resolve, reject) => statuses.push({ resolve, reject }));
      return Promise.resolve({ ok: true, enabled: statusEnabled });
    }
    calls.push(message); return Promise.resolve({ ok: true });
  } },
    storage: { local: { get(key) {
      gets.push(key);
      if (readError) return Promise.reject(new Error('Storage unavailable'));
      if (pending) return new Promise(resolve => { release = resolve; });
      return Promise.resolve({ laterOnSettings: settings });
    } }, onChanged: { addListener(listener) { changes.push(listener); } } } };
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({ window, document, chrome: api, Date: ClockDate,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  if (guard) vm.runInContext(read('picker-keyboard-guard.js'), context);
  const load = () => vm.runInContext(source, context);
  load();
  function key(overrides = {}) {
    const event = { type: 'keydown', code: 'Digit2', key: '€', keyCode: 50, isTrusted: true,
      altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, repeat: false, isComposing: false,
      defaultPrevented: false, prevented: 0, stopped: false,
      preventDefault() { this.defaultPrevented = true; this.prevented++; },
      stopImmediatePropagation() { this.stopped = true; }, ...overrides };
    for (const { listener } of listeners.get(event.type) || []) {
      listener(event); if (event.stopped) break;
    }
    return event;
  }
  return { window, api, context, load, listeners, calls, statusCalls, statuses, timers, gets, key,
    release(value) { release({ laterOnSettings: value }); },
    change(value, area = 'local') { changes.forEach(listener => listener({ laterOnSettings: { newValue: value } }, area)); },
    native(value) { statusEnabled = value; },
    focus(value = true, target = window) { focused = value; for (const { listener } of listeners.get(value ? 'focus' : 'blur') || []) listener({ target }); },
    visibility(value) { visible = value; for (const listener of documentListeners.get('visibilitychange') || []) listener(); },
    advance(milliseconds) { now += milliseconds; for (const [id, task] of [...timers]) if (task.at <= now) { timers.delete(id); task.fn(); } },
    unrelated() { changes.forEach(listener => listener({ laterOnItems: { newValue: [] } }, 'local')); } };
}

(async () => {
  const f = fixture({ pending: true });
  assert.equal(f.key().prevented, 0, 'Do not claim keys while a saved opt-out preference is still loading');
  assert.equal(f.calls.length, 0);
  f.release({}); await tick();
  assert.equal(f.statusCalls.length, 1, 'The first settings read is followed by one read-only native eligibility check');
  const first = f.key();
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.stopped, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].type, 'QUICK_SWITCHER_LEGACY_WINDOW');
  assert.deepEqual(Object.keys(f.calls[0]), ['type'], 'No page-controlled URL or collection data is sent with the trusted shortcut');
  const owner = f.window.LaterOnKeyboardShortcuts;
  f.load();
  assert.equal(f.window.LaterOnKeyboardShortcuts, owner, 'Repeated injections reuse one shortcut listener');
  assert.equal(f.listeners.get('keydown').length, 1);
  assert.deepEqual(f.gets, ['laterOnSettings'], 'Only the small settings key is read once');
  for (const override of [
    { isTrusted: false }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { key: 'Process' },
    { altKey: false }, { shiftKey: false }, { ctrlKey: true }, { metaKey: true },
    { code: 'Numpad2' }, { code: 'KeyO', key: '2' }, { defaultPrevented: true }
  ]) {
    const previous = f.calls.length, event = f.key(override);
    assert.equal(f.calls.length, previous, `Unrelated/synthetic/held/composing keys do not save: ${JSON.stringify(override)}`);
    assert.equal(event.prevented, 0, 'An ignored key retains its existing native/page behavior');
    assert.equal(event.stopped, false);
  }
  const count = f.calls.length;
  f.key({ key: '@' });
  assert.equal(f.calls.length, count + 1, 'The physical code works when macOS Option changes the produced character');
  f.change({ windowShortcutFallback: false });
  assert.equal(f.key().prevented, 0);
  assert.equal(f.calls.length, count + 1, 'A settings opt-out takes effect without reinjection');
  f.change({ windowShortcutFallback: true }, 'session'); f.unrelated();
  f.key();
  assert.equal(f.calls.length, count + 1, 'Session/unrelated storage events cannot override a local opt-out');
  f.change(undefined);
  assert.equal(f.key().prevented, 0, 'Re-enabling preferences does not claim keys until native eligibility is known');
  await tick(); f.key();
  assert.equal(f.calls.length, count + 2, 'Removing the override restores the default only after the worker confirms no native binding');

  const disabled = fixture({ settings: { windowShortcutFallback: false } }); await tick();
  assert.equal(disabled.key().prevented, 0);
  assert.equal(disabled.calls.length, 0, 'Persisted disabled settings are honored from startup');
  assert.equal(disabled.statusCalls.length, 0, 'Disabled documents do not query native shortcut status');
  const race = fixture({ pending: true });
  race.change({ windowShortcutFallback: false }); race.release({ windowShortcutFallback: true }); await tick();
  race.key(); assert.equal(race.calls.length, 0, 'A delayed initial read cannot overwrite a newer opt-out');
  const storageFailed = fixture({ readError: true }); await tick();
  storageFailed.key(); assert.equal(storageFailed.calls.length, 1, 'A read failure still requires affirmative worker eligibility before using the fallback');

  const assigned = fixture({ statusEnabled: false }); await tick();
  assert.equal(assigned.key().prevented, 0); assert.equal(assigned.calls.length, 0, 'A custom native binding leaves the former default key and page behavior untouched');
  assigned.native(true); assigned.advance(1000); assigned.focus();
  assert.equal(assigned.key().prevented, 0, 'Focus invalidates old eligibility while checking the updated Chrome shortcut');
  await tick(); assert.equal(assigned.key().prevented, 1); assert.equal(assigned.calls.length, 1, 'The fallback resumes after its native binding is removed');
  assigned.native(false); assigned.focus(false); assigned.advance(1000); assigned.focus(); await tick();
  assert.equal(assigned.key().prevented, 0); assert.equal(assigned.calls.length, 1, 'Assigning a native command later disables interception when the page regains focus');

  const slowStatus = fixture({ statusPending: true }); await tick();
  assert.equal(slowStatus.statusCalls.length, 1);
  assert.equal(slowStatus.key().prevented, 0, 'Unknown native eligibility never intercepts the key');
  for (let i = 0; i < 30; i++) slowStatus.focus();
  assert.equal(slowStatus.statusCalls.length, 1, 'Focus storms reuse an in-flight eligibility request');
  slowStatus.change({ windowShortcutFallback: false }); slowStatus.statuses[0].resolve({ ok: true, enabled: true }); await tick();
  assert.equal(slowStatus.key().prevented, 0); assert.equal(slowStatus.calls.length, 0, 'A late positive status cannot override a newer preference opt-out');
  slowStatus.change({ windowShortcutFallback: true }); await tick();
  assert.equal(slowStatus.statusCalls.length, 2);
  slowStatus.statuses[1].resolve({ ok: true, enabled: false }); await tick();
  assert.equal(slowStatus.key().prevented, 0, 'A fresh negative native status leaves the old combination intact');
  const overlapping = fixture({ statusPending: true }); await tick();
  overlapping.change({ windowShortcutFallback: false }); overlapping.change({ windowShortcutFallback: true });
  overlapping.statuses[0].resolve({ ok: true, enabled: true }); await tick();
  assert.equal(overlapping.statusCalls.length, 2, 'Re-enabling while an obsolete check is pending schedules one fresh eligibility query');
  assert.equal(overlapping.key().prevented, 0, 'An obsolete positive result does not briefly reactivate the fallback after a preference cycle');
  overlapping.statuses[1].resolve({ ok: true, enabled: false }); await tick();
  assert.equal(overlapping.key().prevented, 0);

  const storm = fixture(); await tick();
  for (let i = 0; i < 30; i++) { storm.focus(); storm.visibility('visible'); }
  assert.equal(storm.statusCalls.length, 1); assert.equal(storm.timers.size, 1, 'Rapid focus/visibility pairs queue at most one throttled recheck');
  assert.equal(storm.key().prevented, 0, 'A throttled recheck keeps uncertain eligibility inactive');
  storm.advance(500); await tick();
  assert.equal(storm.statusCalls.length, 2); assert.equal(storm.key().prevented, 1);
  storm.focus(true, {}); assert.equal(storm.timers.size, 0, 'Focusing a page input does not invalidate or query the window shortcut');
  storm.visibility('hidden'); storm.native(false); storm.advance(500); storm.visibility('visible'); await tick();
  assert.equal(storm.statusCalls.length, 3); assert.equal(storm.key().prevented, 0, 'Returning a visible document refreshes eligibility');

  const background = fixture({ focused: false }); await tick();
  background.visibility('visible'); await tick();
  assert.equal(background.statusCalls.length, 0, 'Unfocused frames and background documents do not fan out native status queries');
  background.focus(); await tick(); assert.equal(background.statusCalls.length, 1);
  const unknown = fixture({ statusPending: true }); await tick();
  unknown.statuses[0].reject(new Error('Worker disconnected')); await tick();
  assert.equal(unknown.key().prevented, 0); assert.equal(unknown.calls.length, 0, 'Failed eligibility requests never swallow a shortcut');

  const modal = fixture({ guard: true }); await tick();
  let held = true, handled = 0;
  const release = modal.window.LaterOnPickerKeyboard.capture(() => { handled++; }, () => held);
  const modalEvent = modal.key();
  assert.equal(handled, 1);
  assert.equal(modalEvent.stopped, true);
  assert.equal(modal.calls.length, 0, 'The earlier modal owner consumes the combination before fallback handling');
  held = false; release();
  modal.key({ type: 'keyup' }); modal.key();
  assert.equal(modal.calls.length, 1, 'The fallback resumes after the modal and its trailing keyup release ownership');

  const disconnected = fixture(); await tick();
  disconnected.api.runtime.sendMessage = () => { throw Error('Extension context invalidated'); };
  assert.doesNotThrow(() => disconnected.key());
  disconnected.api.runtime.sendMessage = () => Promise.reject(new Error('Port closed'));
  assert.doesNotThrow(() => disconnected.key()); await tick();
  disconnected.api.runtime = undefined;
  assert.doesNotThrow(() => disconnected.key(), 'Missing or rejected runtime calls are silently contained');
  console.log('PASS legacy window shortcut: trusted keys, native eligibility and opt-out races, focus/visibility refresh with throttling, modal ownership and disconnected runtime');
})().catch(error => { console.error(error); process.exitCode = 1; });

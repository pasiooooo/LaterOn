// Register at document_start, before page capture listeners can claim modal keys.
(() => {
  if (window.LaterOnPickerKeyboard) return;
  let owner = null;
  const pressed = new Set();
  const intercept = event => {
    if (owner && !owner.active()) owner = null;
    if (!owner && !pressed.size) return;
    const key = event.code || event.key.toLowerCase();
    const trailing = pressed.has(key);
    if (!owner && !trailing) return;
    event.stopImmediatePropagation();
    // A held closing key must not repeat or perform a default action on the page.
    if (!owner) event.preventDefault();
    if (event.type === 'keydown') pressed.add(key);
    if (event.type === 'keyup') pressed.delete(key);
    owner?.handle(event);
  };
  for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, intercept, true);
  window.addEventListener('blur', event => { if (event.target === window) pressed.clear(); }, true);
  window.LaterOnPickerKeyboard = {
    capture(handle, active) {
      const current = { handle, active };
      owner = current;
      return () => { if (owner === current) owner = null; };
    }
  };
})();

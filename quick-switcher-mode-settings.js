// The four mode rows are edited together so triggers can be reassigned safely.
(() => {
  function init(current) {
    const form = document.querySelector('#quickModesForm');
    const tools = globalThis.LaterOnQuickModes;
    if (!form || !tools || form.dataset.ready) return;
    form.dataset.ready = 'true';
    const t = (...args) => globalThis.LaterOnI18n?.t(...args) || String(args[0]);
    const list = form.querySelector('#quickModesRows');
    const save = form.querySelector('#quickModesSave');
    const reset = form.querySelector('#quickModesReset');
    const feedback = form.querySelector('#quickModesFeedback');
    let stored = tools.normalize(current?.quickSwitcherModes), dirty = false, saving = false;
    const signature = value => JSON.stringify(value);
    const node = (tag, className, text) => {
      const result = document.createElement(tag);
      if (className) result.className = className;
      if (text != null) result.textContent = text;
      return result;
    };
    function fill(modes) {
      list.replaceChildren();
      modes.forEach((mode, index) => {
        const row = node('fieldset', 'quick-mode-row'); row.dataset.modeId = mode.id;
        const legend = node('legend', '', index === 0 ? t('quickModesDefault') : t('quickModesSlot', { number: index }));
        const prefix = node('div', 'quick-mode-prefix');
        const label = node('label', 'quick-mode-prefix-label', t(index === 0 ? 'quickModesOnOpen' : 'quickModesTrigger'));
        prefix.append(label);
        if (index === 0) prefix.append(node('span', 'quick-mode-default-trigger', t('quickModesNoPrefix')));
        else {
          const select = node('select', 'setting-select'); select.dataset.prefixType = '';
          select.id = `quickModePrefix-${mode.id}`; label.htmlFor = select.id;
          for (const [value, key] of [['tab', 'quickModesTab'], ['space', 'quickModesSpace'], ['custom', 'quickModesCustom']]) {
            const option = node('option', '', t(key)); option.value = value; select.append(option);
          }
          select.value = mode.prefix === '\t' ? 'tab' : mode.prefix === ' ' ? 'space' : 'custom';
          const custom = node('input', 'quick-mode-custom'); custom.type = 'text'; custom.dataset.prefixValue = '';
          custom.maxLength = 16; custom.autocomplete = 'off'; custom.spellcheck = false;
          custom.setAttribute('autocapitalize', 'off');
          custom.setAttribute('aria-label', t('quickModesCustomLabel', { number: index }));
          custom.placeholder = t('quickModesCustomPlaceholder');
          custom.value = select.value === 'custom' ? mode.prefix : '';
          custom.hidden = select.value !== 'custom';
          prefix.append(select, custom);
        }
        const sources = node('div', 'quick-mode-sources'); sources.setAttribute('role', 'group');
        sources.setAttribute('aria-label', t('quickModesSources'));
        for (const [source, key] of [['tabs', 'quickModesTabs'], ['reading', 'readingLibrary'], ['bookmarks', 'bookmarkLibrary']]) {
          const sourceLabel = node('label'); const checkbox = node('input');
          checkbox.type = 'checkbox'; checkbox.dataset.source = source; checkbox.checked = mode.sources.includes(source);
          sourceLabel.append(checkbox, node('span', '', t(key))); sources.append(sourceLabel);
        }
        row.append(legend, prefix, sources); list.append(row);
      });
    }
    function read() {
      return [...list.querySelectorAll('.quick-mode-row')].map((row, index) => {
        const type = row.querySelector('[data-prefix-type]')?.value;
        return { id: tools.MODE_IDS[index], prefix: index === 0 ? '' : type === 'tab' ? '\t'
          : type === 'space' ? ' ' : row.querySelector('[data-prefix-value]').value,
        sources: [...row.querySelectorAll('[data-source]:checked')].map(input => input.dataset.source) };
      });
    }
    function errorText(error) {
      if (error.code === 'prefixConflict') return t('quickModesConflict', { first: error.index, second: error.otherIndex });
      if (error.code === 'sourceRequired' || error.code === 'unknownSource') return t('quickModesSourceRequired');
      return t('quickModesInvalidPrefix');
    }
    function update(message = '') {
      const draft = read(), validation = tools.validate(draft);
      dirty = signature(draft) !== signature(stored);
      save.disabled = saving || !dirty || !validation.ok; reset.disabled = saving;
      [...list.children].forEach((row, index) => {
        const error = validation.errors.find(item => item.index === index || item.otherIndex === index);
        row.classList.toggle('has-error', !!error);
        row.querySelector('[data-prefix-value]')?.setAttribute('aria-invalid', String(!!error && error.code !== 'sourceRequired'));
      });
      feedback.dataset.phase = validation.ok ? 'ready' : 'error';
      feedback.textContent = !validation.ok ? errorText(validation.errors[0])
        : message || (dirty ? t('quickModesUnsaved') : '');
      return validation;
    }
    form.addEventListener('change', event => {
      if (!event.target.matches('[data-prefix-type], [data-source]')) return;
      const row = event.target.closest('.quick-mode-row');
      const select = row.querySelector('[data-prefix-type]'), input = row.querySelector('[data-prefix-value]');
      if (input && select) {
        input.hidden = select.value !== 'custom';
        if (event.target === select && !input.hidden) input.focus();
      }
      update();
    });
    form.addEventListener('input', event => { if (event.target.matches('[data-prefix-value]')) update(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const validation = update();
      if (saving || !dirty || !validation.ok) return;
      const submitted = validation.modes;
      saving = true; update(t('quickModesSaving'));
      try {
        await globalThis.LaterOnSettings.set({ quickSwitcherModes: submitted });
        stored = tools.normalize((await globalThis.LaterOnSettings.get()).quickSwitcherModes);
        saving = false;
        const applied = signature(stored) === signature(submitted);
        update(!applied ? t('quickModesChangedElsewhere') : signature(read()) === signature(stored)
          ? t('quickModesSaved') : t('quickModesUnsaved'));
      } catch {
        saving = false; update(t('quickModesSaveFailed')); feedback.dataset.phase = 'error';
      }
    });
    reset.addEventListener('click', () => { fill(tools.normalize()); update(t('quickModesResetDraft')); });
    globalThis.LaterOnSettings.watch(next => {
      const modes = tools.normalize(next?.quickSwitcherModes);
      if (signature(modes) === signature(stored)) return;
      stored = modes;
      if (!dirty && !saving) { fill(stored); update(); }
      else if (!saving) update(t('quickModesChangedElsewhere'));
    });
    fill(stored); update();
  }
  globalThis.LaterOnQuickModeSettings = { init };
})();

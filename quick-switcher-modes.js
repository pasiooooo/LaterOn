// Small shared configuration: no collection data, tab IDs or I/O live here.
(() => {
  if (globalThis.LaterOnQuickModes) return;
  const SOURCES = Object.freeze(['tabs', 'reading', 'bookmarks']);
  const MODE_IDS = Object.freeze(['default', 'mode1', 'mode2', 'mode3']);
  const DEFAULTS = Object.freeze([
    { id: 'default', prefix: '', sources: [...SOURCES] },
    { id: 'mode1', prefix: '\t', sources: ['tabs'] },
    { id: 'mode2', prefix: ' ', sources: ['reading'] },
    { id: 'mode3', prefix: "'", sources: ['bookmarks'] }
  ].map(mode => Object.freeze({ ...mode, sources: Object.freeze(mode.sources) })));
  const rows = raw => Array.isArray(raw) ? raw : Array.isArray(raw?.modes) ? raw.modes : [];
  const validPrefix = prefix => typeof prefix === 'string' && prefix.length > 0
    && [...prefix].length <= 8 && (prefix === '\t' || prefix === ' '
      || prefix.trim().length > 0 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(prefix));
  const conflict = (a, b) => a.startsWith(b) || b.startsWith(a);

  function normalizeSources(raw, fallback = SOURCES) {
    const found = SOURCES.filter(source => Array.isArray(raw) && raw.includes(source));
    return found.length ? found : SOURCES.filter(source => Array.isArray(fallback) && fallback.includes(source));
  }
  function normalize(raw) {
    const input = rows(raw);
    const modes = DEFAULTS.map((original, index) => ({ id: original.id,
      prefix: index === 0 ? '' : validPrefix(input[index]?.prefix) ? input[index].prefix : original.prefix,
      sources: normalizeSources(input[index]?.sources, original.sources) }));
    // Malformed imports must not make a mode unreachable. Keep source choices,
    // but restore the three triggers as one set when they overlap.
    const triggered = modes.slice(1);
    if (triggered.some((mode, i) => triggered.slice(i + 1).some(other => conflict(mode.prefix, other.prefix)))) {
      modes.forEach((mode, index) => { mode.prefix = DEFAULTS[index].prefix; });
    }
    return modes;
  }
  function validate(raw) {
    const input = rows(raw), errors = [];
    if (input.length !== DEFAULTS.length) errors.push({ index: -1, code: 'modeCount' });
    DEFAULTS.forEach((_mode, index) => {
      const mode = input[index];
      if (!Array.isArray(mode?.sources) || !mode.sources.some(source => SOURCES.includes(source))) {
        errors.push({ index, code: 'sourceRequired' });
      } else if (mode.sources.some(source => !SOURCES.includes(source))) errors.push({ index, code: 'unknownSource' });
      if (index === 0) {
        if (mode?.prefix !== '') errors.push({ index, code: 'defaultPrefix' });
      } else if (!validPrefix(mode?.prefix)) errors.push({ index, code: 'invalidPrefix' });
    });
    for (let i = 1; i < input.length && i < DEFAULTS.length; i++) {
      if (!validPrefix(input[i]?.prefix)) continue;
      for (let j = i + 1; j < input.length && j < DEFAULTS.length; j++) {
        if (validPrefix(input[j]?.prefix) && conflict(input[i].prefix, input[j].prefix)) {
          errors.push({ index: i, otherIndex: j, code: 'prefixConflict' });
        }
      }
    }
    return { ok: errors.length === 0, errors, modes: normalize(raw) };
  }
  function get(raw, modeId = 'default') {
    const modes = normalize(raw);
    return modes.find(mode => mode.id === modeId) || modes[0];
  }
  function matchPrefix(value, raw) {
    if (typeof value !== 'string' || !value) return null;
    const mode = normalize(raw).slice(1).find(candidate => value.startsWith(candidate.prefix));
    return mode ? { modeId: mode.id, prefix: mode.prefix, query: value.slice(mode.prefix.length),
      sources: [...mode.sources], mode } : null;
  }
  function describeSources(sources, language = 'zh-CN') {
    const labels = language === 'en' ? { tabs: 'Open tabs', reading: 'Reading', bookmarks: 'Bookmarks' }
      : { tabs: '标签页', reading: '阅读库', bookmarks: '书签库' };
    return normalizeSources(sources, []).map(source => labels[source]).join(' + ');
  }
  function describePrefix(prefix, language = 'zh-CN') {
    if (!prefix) return language === 'en' ? 'Default' : '默认';
    if (prefix === '\t') return 'Tab';
    if (prefix === ' ') return language === 'en' ? 'Space' : '空格';
    return String(prefix).replace(/ /g, '␠');
  }
  globalThis.LaterOnQuickModes = { SOURCES, MODE_IDS, DEFAULTS, normalizeSources, normalize,
    validate, get, matchPrefix, describeSources, describePrefix };
})();

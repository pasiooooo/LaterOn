// Minimal namespace-aware XML reader for WebDAV multistatus responses. Service
// workers have no DOMParser. DTDs/entities and malformed XML are rejected.
(function () {
  const LEGACY = 'lateron-sync-v1.json';
  // Timestamped publications and existing UUID-only snapshots share the same
  // document format. Keep both readable during upgrades and compaction.
  const SNAPSHOT = /^lateron-snapshot-v2-(?:\d{8}T\d{9}Z-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
  const DAILY = /^lateron-backup-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\.json$/;
  const invalid = () => { throw new Error('syncInvalidListing'); };
  function decode(text) {
    if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text)) invalid();
    return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => {
      if (!entity.startsWith('#')) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid();
      return String.fromCodePoint(code);
    });
  }
  function parse(xml) {
    if (typeof xml !== 'string' || xml.length > 2 * 1024 * 1024) invalid();
    const document = { children: [], text: '', ns: Object.create(null) }, stack = [document];
    const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w.:-]*(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/g;
    let position = 0, nodes = 0;
    for (const token of xml.matchAll(tokens)) {
      if (token.index !== position) invalid();
      const value = token[0]; position += value.length;
      const parent = stack[stack.length - 1];
      if (value.startsWith('<!--') || value.startsWith('<?')) continue;
      if (value.startsWith('<![CDATA[')) { parent.text += value.slice(9, -3); continue; }
      if (!value.startsWith('<')) { parent.text += decode(value); continue; }
      if (value.startsWith('</')) {
        if (stack.length === 1 || value.slice(2, -1).trim() !== parent.qname) invalid();
        stack.pop(); continue;
      }
      if (++nodes > 20000 || stack.length > 32) invalid();
      const qname = /^<([^\s/>]+)/.exec(value)[1];
      const ns = { ...parent.ns }, attrs = new Set();
      for (const attr of value.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        if (attrs.has(attr[1])) invalid();
        attrs.add(attr[1]);
        const content = decode(attr[2] ?? attr[3]);
        if (attr[1] === 'xmlns') ns[''] = content;
        else if (attr[1].startsWith('xmlns:')) ns[attr[1].slice(6)] = content;
      }
      const parts = qname.split(':');
      if (parts.length > 2 || (parts.length === 2 && !ns[parts[0]])) invalid();
      const node = { qname, name: parts.at(-1), uri: ns[parts.length === 2 ? parts[0] : ''] || '', ns, text: '', children: [] };
      parent.children.push(node);
      if (!value.endsWith('/>')) stack.push(node);
    }
    if (position !== xml.length || stack.length !== 1 || document.children.length !== 1 || document.text.trim()) invalid();
    return document.children[0];
  }
  const children = (node, name) => node.children.filter(child => child.uri === 'DAV:' && child.name === name);
  function names(xml, baseUrl) {
    const root = parse(xml);
    if (root.uri !== 'DAV:' || root.name !== 'multistatus') invalid();
    const base = new URL(baseUrl), output = new Set();
    for (const response of children(root, 'response')) {
      const hrefs = children(response, 'href');
      if (hrefs.length !== 1 || hrefs[0].children.length) invalid();
      let url, name;
      try {
        url = new URL(hrefs[0].text.trim(), base);
        name = decodeURIComponent(url.pathname.split('/').pop());
      } catch { invalid(); }
      if (url.origin !== base.origin || url.username || url.password || url.search || url.hash
        || decodeURIComponent(new URL('.', url).pathname) !== decodeURIComponent(base.pathname)) continue;
      if (name !== LEGACY && !SNAPSHOT.test(name) && !DAILY.test(name)) continue;
      const statuses = [...children(response, 'status'), ...children(response, 'propstat').flatMap(prop => children(prop, 'status'))];
      if (!statuses.some(node => /^HTTP\/\d(?:\.\d)?\s+2\d\d(?:\s|$)/.test(node.text.trim()))) invalid();
      output.add(name);
    }
    return [...output].sort();
  }
  globalThis.LaterOnWebDAVDirectory = { names, LEGACY, SNAPSHOT, DAILY };
})();

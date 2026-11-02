// Static HTML metadata shared by URL imports, page rescue and bookmark previews.
(() => {
  const decode = text => String(text || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, value) => {
    if (value[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[value.toLowerCase()];
    const point = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\ufffd';
  }).trim();
  const attributes = tag => {
    const attrs = {};
    for (const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const key = match[1].toLowerCase();
      if (!(key in attrs)) attrs[key] = decode(match[2] ?? match[3] ?? match[4]);
    }
    return attrs;
  };
  const generic = value => /(?:^|[/_-])(?:favicon|icon|apple-touch-icon|logo|sprite|placeholder|spacer|blank|avatar)(?:[/_.@-]|$)|\.(?:svg|ico)(?:[?#]|$)|\/(?:fe-platform|fe-static|og-image-default|default-(?:cover|image|thumb|share))\//i.test(value);
  function parse(input, url) {
    const html = String(input || '').slice(0, 256 * 1024).replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    const head = html.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
    const tags = [...head.matchAll(/<(meta|link|base|video|img)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)]
      .map(match => ({ name: match[1].toLowerCase(), attrs: attributes(match[0]) }));
    const absolute = (value, base = url) => {
      if (!value) return '';
      try { const result = new URL(value, base); return /^https?:$/.test(result.protocol) ? result.href : ''; } catch { return ''; }
    };
    const base = absolute(tags.find(tag => tag.name === 'base' && tag.attrs.href)?.attrs.href) || url;
    const meta = name => tags.find(tag => tag.name === 'meta' &&
      (tag.attrs.property || tag.attrs.name || tag.attrs.itemprop || '').toLowerCase() === name && tag.attrs.content)?.attrs.content || '';
    const candidate = value => { const image = absolute(value, base); return image && !generic(image) ? image : ''; };
    const structured = { image: '', description: '', title: '' };
    const pickImage = value => {
      if (typeof value === 'string') return candidate(value);
      if (Array.isArray(value)) return value.slice(0, 8).map(pickImage).find(Boolean) || '';
      return value && typeof value === 'object' ? candidate(value.url || value.contentUrl) : '';
    };
    let scripts = 0;
    for (const match of html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (attributes(match[1]).type?.toLowerCase() !== 'application/ld+json') continue;
      if (++scripts > 8) break;
      try {
        const data = JSON.parse(match[2]);
        const entries = (Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data]).slice(0, 80);
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue;
          structured.image ||= pickImage(entry.image || entry.thumbnailUrl);
          if (typeof entry.description === 'string') structured.description ||= entry.description.trim();
          if (typeof (entry.headline || entry.name) === 'string') structured.title ||= (entry.headline || entry.name).trim();
        }
      } catch {}
    }
    let image = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src', 'image']
      .map(name => candidate(meta(name))).find(Boolean) || '';
    image ||= tags.filter(tag => tag.name === 'link' && /(?:^|\s)image_src(?:\s|$)/i.test(tag.attrs.rel || ''))
      .map(tag => candidate(tag.attrs.href)).find(Boolean) || '';
    image ||= structured.image;
    image ||= tags.filter(tag => tag.name === 'video').map(tag => candidate(tag.attrs.poster)).find(Boolean) || '';
    // Size-qualified body images are a last resort, never icons or tiny tracking pixels.
    image ||= tags.filter(tag => tag.name === 'img').slice(0, 80)
      .filter(tag => Number(tag.attrs.width) >= 320 && Number(tag.attrs.height) >= 160)
      .sort((a, b) => Number(b.attrs.width) * Number(b.attrs.height) - Number(a.attrs.width) * Number(a.attrs.height))
      .map(tag => candidate(tag.attrs['data-src'] || tag.attrs['data-original'] || tag.attrs.src)).find(Boolean) || '';
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    return { url, title: meta('og:title') || meta('twitter:title') || structured.title || decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]),
      description: meta('og:description') || meta('twitter:description') || meta('description') || structured.description,
      image, favicon: tags.filter(tag => tag.name === 'link' && /(?:^|\s)(?:icon|apple-touch-icon|apple-touch-icon-precomposed)(?:\s|$)/i.test(tag.attrs.rel || ''))
        .map(tag => absolute(tag.attrs.href, base)).find(Boolean) || absolute('/favicon.ico'), source: meta('og:site_name') || host };
  }
  globalThis.LaterOnPageMetadata = { parse, isGenericImage: generic };
})();

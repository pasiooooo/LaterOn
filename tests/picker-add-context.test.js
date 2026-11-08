const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.resolve(__dirname, '../picker-ui.js'), 'utf8');
const overlaySource = fs.readFileSync(path.resolve(__dirname, '../content-folder-picker.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

(async () => {
  const dom = new JSDOM('<!doctype html><html><body><button id="anchor">Move</button></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.eval(source);
  window.fetch = () => { throw new Error('The picker must use the supplied snapshot'); };
  const folders = [
    { id: '', name: 'Inbox', count: 50, matchedCount: 0 },
    { id: 'work', name: 'Work', count: 100, matchedCount: 2 },
    { id: 'design', name: 'Design', count: 20, matchedCount: 1 },
    { id: 'fresh', name: 'Fresh', count: 10, matchedCount: 0 }
  ];
  const mixedContext = {
    total: 7, savedCount: 5, newCount: 2, sameProjectId: null,
    groups: [
      { projectId: 'work', projectName: 'Work', count: 2 },
      { projectId: 'design', projectName: 'Design', count: 1 },
      { projectId: 'archived', projectName: 'Archived project (archived)', count: 1, archived: true },
      { projectId: 'deleted', projectName: 'Deleted project (missing)', count: 1, missing: true }
    ]
  };
  const mixedPages = [
    { title: 'Saved Work', url: 'https://example.com/work', saved: true, projectId: 'work', projectName: 'Work' },
    { title: 'Archived page', url: 'https://example.com/archive', saved: true, projectId: 'archived', projectName: 'Archived project (archived)' },
    { title: 'Missing page', url: 'https://example.com/missing', saved: true, projectId: 'deleted', projectName: 'Deleted project (missing)' },
    { title: 'New page', url: 'https://example.com/new', saved: false },
    { title: 'Second Work page', url: 'https://example.com/work-2', saved: true, projectId: 'work', projectName: 'Work' },
    { title: 'Design page', url: 'https://example.com/design', saved: true, projectId: 'design', projectName: 'Design' },
    { title: 'Second new page', url: 'https://example.com/new-2', saved: false }
  ];
  const open = options => {
    const layer = window.openFolderPicker({ folders, selected: 'work', pages: mixedPages, savedCount: 5, ...options });
    const shadow = window.document.querySelector('#lateron-folder-picker').shadowRoot;
    const q = selector => shadow.querySelector(selector);
    return { layer, shadow, q, button: q('.lon-primary'), input: q('.lon-search-input'),
      filter(text) { this.input.value = text; this.input.dispatchEvent(new window.Event('input', { bubbles: true })); },
      choose(name) { [...shadow.querySelectorAll('.lon-folder')].find(row => row.querySelector('.lon-folder-name').textContent === name).click(); },
      key(key, extra = {}) { this.input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...extra })); }
    };
  };
  const copies = {
    'zh-CN': {
      same: '这2篇都已在「Work」', keep: '保留在「Work」', move: '移入「Design」', allHere: '全部已在这里',
      initialPreview: '新增0 · 保留2 · 移入0', movedPreview: '新增0 · 保留0 · 移入2',
      mixed: '2篇待添加 · 5篇已存', mixedButton: '添加2篇并移入3篇', mixedPreview: '新增2 · 保留2 · 移入3',
      filteredPreview: '新增2 · 保留1 · 移入4', freshPreview: '新增2 · 保留0 · 移入5', more: '另1个项目',
      here: '已在这里 2篇', pending: '待添加', saved: '已在「Work」', savedArchive: '已在「Archived project (archived)」',
      allNew: '选好项目后就会开始逐个添加', addFresh: '添加到「Fresh」', create: '新建「Novel Notes」并添加', inbox: '保留在「等待整理」'
    },
    en: {
      same: 'All 2 pages are already in “Work”', keep: 'Keep in “Work”', move: 'Move to “Design”', allHere: 'All already here',
      initialPreview: 'Add 0 · Keep 2 · Move 0', movedPreview: 'Add 0 · Keep 0 · Move 2',
      mixed: '2 to add · 5 already saved', mixedButton: 'Add 2 and move 3 pages', mixedPreview: 'Add 2 · Keep 2 · Move 3',
      filteredPreview: 'Add 2 · Keep 1 · Move 4', freshPreview: 'Add 2 · Keep 0 · Move 5', more: '1 more project',
      here: '2 already here', pending: 'To add', saved: 'Already in “Work”', savedArchive: 'Already in “Archived project (archived)”',
      allNew: 'choose a project to start adding them one by one', addFresh: 'Add to “Fresh”', create: 'Create “Novel Notes” and add', inbox: 'Keep in “Inbox”'
    }
  };
  let scenarios = 0;
  try {
    for (const language of ['zh-CN', 'en']) {
      const copy = copies[language];
      const sameFolders = folders.map(folder => ({ ...folder, matchedCount: folder.id === 'work' ? 2 : 0 }));
      const sameContext = { total: 2, savedCount: 2, newCount: 0, groups: [{ projectId: 'work', projectName: 'Work', count: 2 }], sameProjectId: 'work' };
      const samePages = [mixedPages[0], mixedPages[4], mixedPages[0]];
      let p = open({ language, folders: sameFolders, pages: samePages, saveContext: sameContext });
      assert.equal(p.q('.lon-summary').textContent, copy.same, 'Original membership is visible immediately');
      assert.equal(p.q('.lon-pages-label').textContent, language === 'en' ? 'View 3 tabs (2 unique pages)' : '查看 3 个标签页（共 2 个网页）', 'Repeated tabs explain why details contain more entries than the unique save count');
      assert.equal(p.q('.lon-folder[aria-checked="true"] .lon-folder-name').textContent, 'Work');
      assert.equal(p.button.textContent, copy.keep);
      assert.equal(p.q('.lon-folder-matched').textContent, copy.allHere);
      assert.equal(p.q('.lon-folder-count').textContent, '50', 'Whole-project totals remain distinct');
      assert(p.q('.lon-action-preview').textContent.includes(copy.initialPreview));
      p.choose('Design');
      assert.equal(p.button.textContent, copy.move);
      assert(p.q('.lon-action-preview').textContent.includes(copy.movedPreview));
      assert.equal(p.q('.lon-summary').textContent, copy.same, 'Changing destination does not rewrite original membership');
      p.filter('Novel Notes');
      assert.equal(p.button.textContent, language === 'en' ? 'Create “Novel Notes” and move' : '新建「Novel Notes」并移入', 'Creating a destination for all-saved pages clearly moves them');
      assert(p.q('.lon-action-preview').textContent.includes(copy.movedPreview));
      for (const selector of ['.lon-summary', '.lon-action-preview']) {
        assert.equal(p.q(selector).getAttribute('role'), 'status');
        assert.equal(p.q(selector).getAttribute('aria-live'), 'polite');
      }
      p.layer.close(); scenarios++;

      p = open({ language, folders: sameFolders.map(folder => ({ ...folder, matchedCount: folder.id === 'work' ? 1 : 0 })), pages: [samePages[0]], saveContext: { ...sameContext, total: 1, savedCount: 1, groups: [{ projectId: 'work', projectName: 'Work', count: 1 }] } });
      assert.equal(p.q('.lon-pages-label').textContent, language === 'en' ? 'View 1 page and its current project' : '查看 1 个网页及当前归属', 'A single saved page has the correct singular details label');
      p.layer.close(); scenarios++;

      p = open({ language, selected: '', folders: folders.map(folder => ({ ...folder, matchedCount: folder.id === '' ? 2 : 0 })), saveContext: { ...sameContext, sameProjectId: '', groups: [{ projectId: '', projectName: 'Inbox', count: 2 }] } });
      assert.equal(p.button.textContent, copy.inbox, 'The empty-string Inbox ID is a real same-project target');
      assert.equal(p.q('.lon-folder[aria-checked="true"] .lon-folder-name').textContent, 'Inbox');
      p.layer.close(); scenarios++;

      const snapshot = JSON.stringify({ folders, mixedContext, mixedPages });
      p = open({ language, saveContext: mixedContext });
      assert.equal(p.q('.lon-summary').textContent, copy.mixed);
      assert.equal(p.q('.lon-pages-label').textContent, language === 'en' ? 'View 7 pages and their current projects' : '查看 7 个网页及当前归属', 'Partial membership uses the same neutral details label');
      assert.equal(p.button.textContent, copy.mixedButton);
      assert(p.q('.lon-action-preview').textContent.includes(copy.mixedPreview));
      assert.equal(p.shadow.querySelectorAll('.lon-existing-group').length, 3);
      assert.equal(p.q('.lon-existing-more').textContent, copy.more);
      assert.equal(p.q('.lon-folder-matched').textContent, copy.here);
      const workRow = [...p.shadow.querySelectorAll('.lon-folder')].find(row => row.querySelector('.lon-folder-name').textContent === 'Work');
      assert.equal(workRow.querySelector('.lon-folder-count').textContent, '100');
      assert(workRow.querySelector('.lon-folder-count').title.includes('100'));
      const statuses = [...p.shadow.querySelectorAll('.lon-page-status')].map(node => node.textContent);
      assert.equal(statuses[0], copy.saved); assert.equal(statuses[1], copy.savedArchive); assert.equal(statuses[3], copy.pending);
      assert(statuses[2].includes('(missing)'));
      assert.equal(p.q('.lon-page-url').textContent, mixedPages[0].url);
      p.filter('Design');
      assert.equal(p.shadow.querySelectorAll('.lon-folder').length, 1);
      assert.equal(p.q('.lon-folder').getAttribute('aria-checked'), 'true');
      assert(p.q('.lon-action-preview').textContent.includes(copy.filteredPreview));
      p.filter(''); p.choose('Fresh');
      assert(p.q('.lon-action-preview').textContent.includes(copy.freshPreview));
      assert.equal(JSON.stringify({ folders, mixedContext, mixedPages }), snapshot, 'Selection never mutates the supplied snapshot');
      p.layer.close(); scenarios++;

      p = open({ language, saveContext: { ...mixedContext, total: 3, newCount: 2, savedCount: 1, groups: [{ projectId: 'work', projectName: 'Work', count: 1 }] }, folders: folders.map(folder => ({ ...folder, matchedCount: folder.id === 'work' ? 1 : 0 })) });
      assert.equal(p.button.textContent, language === 'en' ? 'Add to “Work”' : '添加到「Work」', 'Add-only action keeps the destination in the button');
      p.layer.close(); scenarios++;

      let attempts = 0, picks = 0, release;
      p = open({ language, saveContext: mixedContext,
        onCreateProject() { attempts++; return attempts === 1 ? null : new Promise(resolve => { release = resolve; }); },
        onPick(id) { picks++; assert.equal(id, 'created'); return picks === 1 ? { ok: false, error: '<b>Retry save</b>' } : { ok: true }; }
      });
      p.filter('Novel Notes');
      assert.equal(p.button.textContent, copy.create);
      assert(p.q('.lon-action-preview').textContent.includes(copy.freshPreview), 'Creating a new destination previews all saved pages moving');
      p.key('Enter', { isComposing: true }); p.key('Escape', { keyCode: 229 }); await tick();
      assert.equal(attempts, 0, 'IME does not create or cancel');
      p.button.click(); await tick();
      assert.equal(attempts, 1); assert.equal(picks, 0); assert.equal(p.button.disabled, false);
      p.button.click(); await tick();
      assert.equal(p.input.readOnly, true); assert.equal(p.button.disabled, true);
      p.key('Enter'); p.button.click(); assert.equal(attempts, 2, 'Busy work cannot be duplicated');
      release({ id: 'created', name: 'Novel Notes' }); await tick();
      assert.equal(picks, 1); assert.equal(p.button.disabled, false);
      assert(p.q('.lon-action-preview').textContent.includes(copy.freshPreview), 'The created folder gets a fresh zero match count');
      assert.equal(p.q('.lon-summary').textContent, '<b>Retry save</b>');
      assert.equal(p.shadow.querySelector('b'), null, 'Service errors are text');
      p.button.click(); await tick();
      assert.equal(picks, 2); assert.equal(attempts, 2, 'Retry reuses the already-created project');
      p.layer.close(); scenarios++;

      p = open({ language, saveContext: mixedContext, onCreateProject: () => ({ id: 'design', name: 'Design' }), onPick: () => ({ ok: false, error: 'Retry' }) });
      p.filter('New alias'); p.button.click(); await tick();
      assert(p.q('.lon-action-preview').textContent.includes(copy.filteredPreview), 'A create response resolving to an existing folder uses that folder’s current match count');
      p.layer.close(); scenarios++;

      p = open({ language, selected: '', pages: [{ title: 'One', url: 'https://example.com/one', saved: false }, { title: 'Two', url: 'https://example.com/two', saved: false }], savedCount: 0, saveContext: { total: 2, newCount: 2, savedCount: 0, groups: [], sameProjectId: null } });
      assert(p.q('.lon-summary').textContent.includes(copy.allNew));
      assert.equal(p.q('.lon-pages-label').textContent, language === 'en' ? 'View the 2 pages to be added' : '查看将要添加的 2 个网页', 'All-new retains the original details label');
      assert.equal(p.q('.lon-existing').hidden, true); assert.equal(p.q('.lon-action-preview').hidden, true);
      assert.equal(p.q('.lon-folder[aria-checked="true"] .lon-folder-name').textContent, 'Inbox');
      assert.equal(p.shadow.querySelectorAll('.lon-folder-matched').length, 0, 'All-new keeps the familiar picker');
      p.choose('Fresh'); assert.equal(p.button.textContent, copy.addFresh);
      p.layer.close(); scenarios++;

      for (const anchor of [null, window.document.querySelector('#anchor')]) {
        p = open({ language, anchor, saveContext: anchor ? mixedContext : undefined });
        assert.equal(p.q('.lon-action-preview').hidden, true); assert.equal(p.q('.lon-existing').hidden, true);
        assert.equal(p.q('.lon-pages-label').textContent, language === 'en' ? 'View the 7 pages to be added' : '查看将要添加的 7 个网页', 'Legacy and popover calls retain the original details label');
        assert.equal(p.shadow.querySelectorAll('.lon-page-status').length, 0);
        assert.equal(p.shadow.querySelectorAll('.lon-folder-matched').length, 0);
        assert.equal(p.button.textContent, anchor ? (language === 'en' ? 'Move to “Work”' : '移动到「Work」') : (language === 'en' ? 'Add to “Work”' : '添加到「Work」'));
        p.layer.close(); scenarios++;
      }
    }

    const hostileName = '<img src=x onerror=alert(1)>' + 'long-project-name'.repeat(20);
    const safeContext = { total: 1, newCount: 0, savedCount: 1, sameProjectId: 'hostile', groups: [{ projectId: 'hostile', projectName: hostileName, count: 1 }] };
    const p = open({ selected: 'hostile', folders: [{ id: 'hostile', name: hostileName, count: 100, matchedCount: 1 }], saveContext: safeContext, pages: [{ title: '<script>alert(1)</script>', url: 'https://example.com/' + 'x'.repeat(200), saved: true, projectName: hostileName }] });
    assert.equal(p.shadow.querySelector('script'), null); assert.equal(p.shadow.querySelector('.lon-folder img'), null);
    assert(p.q('.lon-summary').textContent.includes(hostileName));
    assert(p.q('.lon-page-status').textContent.includes(hostileName));
    assert.equal(p.q('.lon-pages').hidden, false, 'A saved single page can reveal its current location');
    assert(source.includes('.lon-action-preview') && /\.lon-summary[^}]*overflow-wrap: anywhere/.test(source));
    assert(/\.lon-folder-info[^}]*min-width: 0/.test(source));
    assert(/\.lon-existing-group[^}]*max-width: 100%/.test(source), 'Long context names have bounded, ellipsized chips');
    p.layer.close(); scenarios++;

    const sent = [];
    window.chrome = { runtime: { sendMessage: message => { sent.push(message); return Promise.resolve({ ok: false, error: 'Keep testing' }); } } };
    window.eval(overlaySource);
    window.showFolderPickerOverlay({ language: 'en', folders, selected: 'work', pages: mixedPages, savedCount: 5, saveContext: mixedContext });
    const overlay = window.document.querySelector('#lateron-folder-picker').shadowRoot;
    assert.equal(overlay.querySelector('.lon-summary').textContent, copies.en.mixed, 'The injected overlay forwards saveContext');
    overlay.querySelector('.lon-primary').click(); await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { type: 'CONFIRM_BATCH_SAVE', projectId: 'work' }, 'The final save message stays unchanged');
    scenarios++;

    const frames = [];
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    const flushFrames = () => { frames.splice(0).forEach(callback => callback(0)); };
    window.scrollTo = () => { throw new Error('Opening a picker must not scroll the page'); };
    window.HTMLElement.prototype.scrollIntoView = () => { throw new Error('Only the folder list may scroll'); };
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Initial visibility must not use storage'); } });
    window.chrome.storage = { local: { get() { throw new Error('No storage reads'); }, set() { throw new Error('No storage writes'); } } };
    const longFolders = [
      ...Array.from({ length: 41 }, (_, i) => ({ id: `project-${i}`, name: `Project ${i}`, count: i, matchedCount: 0 })),
      { id: 'work', name: 'Work', count: 100, matchedCount: 1 }
    ];
    const common = { total: 1, newCount: 0, savedCount: 1, groups: [{ projectId: 'work', projectName: 'Work', count: 1 }], sameProjectId: 'work' };
    const prepareScroll = (options = {}, rowTop = 2798, rowBottom = 2858, scale = 1) => {
      const picker = open({ folders: longFolders, pages: [mixedPages[0]], saveContext: common, ...options });
      const box = picker.q('.lon-folders');
      const selectedRow = picker.q('.lon-folder[aria-checked="true"]');
      Object.defineProperty(box, 'offsetHeight', { configurable: true, value: 230 });
      box.getBoundingClientRect = () => ({ top: 336, bottom: 336 + 230 * scale, height: 230 * scale });
      if (selectedRow) selectedRow.getBoundingClientRect = () => ({ top: 336 + (rowTop - 336) * scale, bottom: 336 + (rowBottom - 336) * scale, height: (rowBottom - rowTop) * scale });
      picker.q('.lon-root').scrollTop = 17;
      return { picker, box };
    };
    let scrolling = prepareScroll();
    assert.equal(scrolling.box.scrollTop, 0, 'Visibility waits for the initial layout frame');
    assert.equal(scrolling.picker.shadow.activeElement, scrolling.picker.input);
    flushFrames();
    assert.equal(scrolling.box.scrollTop, 2292, 'The common project at row 42 scrolls only enough to enter the list');
    assert.equal(scrolling.picker.shadow.activeElement, scrolling.picker.input, 'Scrolling preserves input focus');
    assert.equal(scrolling.picker.q('.lon-root').scrollTop, 17, 'The outer picker does not scroll');
    assert.equal(window.scrollY, 0, 'The underlying page does not scroll');
    assert.deepEqual([...scrolling.picker.shadow.querySelectorAll('.lon-folder-name')].map(node => node.textContent), longFolders.map(folder => folder.name), 'Initial visibility never reorders projects');
    scrolling.picker.layer.close(); scenarios++;

    scrolling = prepareScroll({}, 200, 260); scrolling.box.scrollTop = 200; flushFrames();
    assert.equal(scrolling.box.scrollTop, 64, 'A common row above the viewport uses the top boundary delta');
    scrolling.picker.layer.close(); scenarios++;
    scrolling = prepareScroll({}, 400, 460); scrolling.box.scrollTop = 200; flushFrames();
    assert.equal(scrolling.box.scrollTop, 200, 'An already-visible common row does not move');
    scrolling.picker.layer.close(); scenarios++;
    scrolling = prepareScroll({}, 2798, 2858, 0.97); flushFrames();
    assert(Math.abs(scrolling.box.scrollTop - 2292) < 0.001, 'Entrance animation scale is converted back to scroll layout pixels');
    scrolling.picker.layer.close(); scenarios++;

    scrolling = prepareScroll({ selected: '', folders: longFolders.map(folder => folder.id === 'work' ? { ...folder, id: '', name: 'Inbox' } : folder), saveContext: { ...common, sameProjectId: '', groups: [{ projectId: '', projectName: 'Inbox', count: 1 }] } });
    flushFrames(); assert.equal(scrolling.box.scrollTop, 2292, 'The empty-string common Inbox ID also scrolls into view');
    scrolling.picker.layer.close(); scenarios++;
    for (const options of [
      { saveContext: mixedContext },
      { savedCount: 0, saveContext: { total: 1, savedCount: 0, newCount: 1, groups: [], sameProjectId: null } },
      { saveContext: undefined },
      { anchor: window.document.querySelector('#anchor') },
      { selected: 'project-0' },
      { selected: 'missing', saveContext: { ...common, sameProjectId: 'missing', groups: [{ projectId: 'missing', projectName: 'Missing project', count: 1, missing: true }] } },
      { saveContext: { ...common, sameProjectId: null, groups: [{ projectId: 'archived', projectName: 'Archived project', count: 1, archived: true }] } }
    ]) {
      scrolling = prepareScroll(options); flushFrames();
      assert.equal(scrolling.box.scrollTop, 0, 'Mixed/new/legacy/popover, changed selection and unavailable common projects do not auto-scroll');
      scrolling.picker.layer.close(); scenarios++;
    }
    scrolling = prepareScroll(); scrolling.picker.layer.close(); flushFrames();
    assert.equal(scrolling.box.scrollTop, 0, 'A closed picker never performs a delayed scroll');
    scenarios++;
    console.log(`PASS picker add context: ${scenarios} scenarios cover both languages, immediate same-project/Inbox status, partial membership, unique snapshot counts, filters, creates, retry/busy/IME, safe text, live status, popovers, all-new and legacy fallbacks`);
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

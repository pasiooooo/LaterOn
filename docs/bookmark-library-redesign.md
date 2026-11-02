# Reading And Bookmark Libraries: Shared Browsing Experience

## Direction

The user explicitly rejects the separate settings-heavy, flat bookmark list. Reuse the existing reading library's shell, tokens, folder boards, preview mosaics and page cards. Do not merge native bookmarks into reading items.

Alternatives: patching the existing flat list fails the hierarchy/preview requirement; merging the two storage models violates permanent-bookmark isolation. The chosen approach shares the browsing language while retaining independent native bookmark operations.

## Interface Contract

- Reading / 阅读库 and Bookmarks / 书签库 are sibling destinations, with the same prominent two-way switch in both full-page sidebars and the reading side panel. Remove the footer-only bookmark entry.
- Match the reading library's 78px header, 248px sidebar, warm surfaces, orange accents, grid density and preview aspect ratios. No large hero or always-expanded settings card.
- Show real nested folder lists with independently expandable branches, direct selection, descendant page counts and breadcrumbs. Store selection/expansion locally, never in browser bookmarks or WebDAV.
- The home view shows root folder boards with descendant preview mosaics and bookmark page cards. A folder shows immediate child folder boards and its direct pages; searching a folder includes its descendants. Preserve native folder order.
- Page cards show a cover/site fallback, native title, preview summary and source/folder. Do not add read states or auto-clean controls. Long titles may wrap; no fixed-height clipping of text. Empty/disabled/error/managed states remain explicit.
- Keep sync configuration collapsed when connected; show it when access or scope needs repair. Existing create/edit/move/delete/transfer actions remain available with unchanged native safety rules.

## Preview Contract

- The current-page card shares reading-sidepanel metadata through a separate session-only backend cache and single-flight request. It may extract the actively viewed page on first access or expiry; this does not enrich the saved bookmark collection. Cache page facts only, never reading membership, read state, bookmark membership or destination folders. Each library recomputes its own saved state from its own records.
- Keep at most 20 current-tab snapshots and approximately 1 MiB of session metadata. Complete snapshots expire after 15 minutes; incomplete ones retry after ten seconds. Navigation, same-URL reload and tab closure invalidate old work, title changes drop old cached facts, and late image callbacks cannot repaint another page. Session storage survives worker sleep but not browser restart or extension reload.
- Seed a dedicated device-local preview cache from matching reading-library metadata, copying local covers so later reading cleanup cannot break previews. Native bookmark titles remain authoritative.
- Missing remote previews are requested explicitly for the current view in bounded batches. Never create, activate, navigate, unfreeze or close tabs, execute website scripts, bulk-fetch the whole bookmark collection, or write preview metadata to native bookmarks. Explicit enrichment may reuse the same read-only content extractor as page addition in an already-loaded matching tab, checking tab readiness and both native/document URLs before accepting results. Static fallback shares the import/add-page HTML parser.
- Only HTTP(S) URLs without embedded credentials and without recognizable local/private hosts or address literals may be fetched. Redirects fail closed. This is URL validation, not DNS validation: the extension cannot inspect actual hostname resolution or prevent DNS rebinding, so it does not guarantee network-level private-address isolation. Revalidate native scope/URL before each request and before committing results; discard responses for deleted, moved-out-of-scope or changed-URL nodes.
- Fetches run outside the native mutation queue, at most two concurrently; serialize the final cache commit. Fetch failure keeps the local/site fallback. Preview cache and view state are excluded from reading wipe, backup, WebDAV and cleanup.
- Each click handles at most 12 current-view nodes, prioritizing never-attempted nodes so sites without covers cannot monopolize successive batches. Explicit retries remain available immediately, including after the user opens a previously unreadable page.
- Each HTML or image response has a real eight-second abort deadline. Stream at most 256 KiB of HTML or 4 MiB of image bytes; cancel oversized streams, and reject truncated images and SVG. Decode images only on explicit retrieval, reject decoded dimensions over 40 megapixels, and proportionally downsample to a 1024px longest edge and at most 512 KiB of local thumbnail bytes. Release image bitmaps after conversion. Each node tries at most three distinct public cover candidates (rendered, known reading cover and static HTML). Render only bounded data-image URLs, never uncached remote images or favicons.
- Cache at most 300 entries and 8 MiB of estimated UTF-16 record bytes, evicting oldest entries and removing previews whose native ID/URL no longer matches. Scope/enable/permission invalidation aborts active requests and prevents pending responses from being committed.

## Verification

1. DOM tests: sibling entry points, nested folders, collapse/expand, breadcrumb navigation, descendant search, folder boards, card previews, pagination and persistent view state.
2. Isolated backend tests: local preview seeding, permanent copies, opt-in network retrieval, scope/URL changes during requests, bounded concurrency, private URL rejection and native/reading isolation.
3. Real-browser fixtures at 1440px, 768px and 320px, Chinese/English and dark mode. Assert viewport has no horizontal overflow, control/text line boxes have sufficient height, and long names do not clip vertically. Inspect screenshots, not only DOM tests.
4. Full regression suite, release package validation, separate commit and release after the naming-only 1.70.1 release.

Reproduce the offline browser fixture with `node tests/build-bookmark-preview.js`, then open `/private/tmp/lateron-library-redesign/bookmarks.html`. Add `?theme=dark&language=en` for the English dark variant. The fixture replaces native bookmark/storage/network APIs and uses synthetic PNG covers; it never reads or writes personal browser bookmarks. The adjacent `library.html` is the actual reading UI with its existing fixture data for entry-point comparison.

### Release Validation (2026-11-02)

- All 70 test files pass, including preview abort/stream/cache budgets, multi-batch progress, restored navigation, native mutation safety and reading-library isolation.
- Chromium fixtures: Chinese light at 1440/768/320px and English dark at 1440/320px; document scroll width equals viewport width, title scroll heights equal their visible heights, and folder rows measure at least 44px. Screenshots were inspected as well as measured.
- Long mixed Chinese/English folder boards and 320px folder headings wrap without vertical clipping. Nested navigation, content scroll reset, breadcrumbs, add-page and sync-scope controls were exercised with isolated data.
- Runtime syntax checks, whitespace checks and release ZIP/source comparison pass. The archive contains 51 allowlisted runtime/license files and no fixtures, design documents or screenshots.
- This is isolated browser acceptance, not a real-profile extension install or personal-bookmark write test. Live native permission prompts, browser synchronization between devices and third-party preview availability remain unverified.

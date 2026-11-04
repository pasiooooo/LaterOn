# Bookmark Side-Panel Surface

The side-panel switch keeps `sidepanel.html` and `bookmarks.html?surface=sidepanel` alive in one side panel. `sidepanel-switch.js` retains the entry document and lazily mounts the alternate surface in one same-origin iframe. It keeps the current view visible until the target controller has loaded its initial data (or exposed a retryable error), then swaps visibility without a navigation, boot skeleton or repeated image loading. A bookmark placeholder render cannot signal readiness. Returning restores the same DOM, search, folder and scroll position. Either surface can be the entry document; child navigation delegates to the owner instead of nesting more frames. Explicit transfers may load a fresh bookmark operation, while normal switching retains both views. Full-page bookmark URLs retain the desktop layout.

## Shared Logic, Different Layout

- `bookmark-sidepanel.js` selects the surface before paint and enables the actual reading side-panel base CSS plus bookmark-specific compact overrides. It mounts the existing bookmark DOM into a compact navigation/search/current-page/list layout, rather than embedding a narrow desktop page or duplicating native mutation logic.
- `bookmarks.js`, `bookmark-view.js`, native synchronization, permissions, confirmation dialogs and preview data remain shared. No bookmark mutation is performed merely by entering the side panel.
- Folder previews become horizontally scrollable compact chips; the hierarchy is an inline, collapsed navigator. Bookmark cards use the reading side panel's 92px thumbnail and vertical-list proportions. No read/unread or cleanup controls are introduced.
- The compact view uses `laterOnBookmarkSidepanelView`; the desktop continues to use `laterOnBookmarkView`. Both remain device-local and excluded from reading backups, cleanup and WebDAV.

## Current Page And Full-Page Handoff

- Read the active tab in the current browser window. Reading and bookmark current-page cards share the same metadata extractor and short-lived session cache; a missing or expired entry may fetch its HTML and cover. The list independently queues automatic preview jobs, reusing saved reading covers and summaries first.
- Ignore stale queries and changes from other windows. Queries have a four-second deadline. Only HTTP(S) pages can be added; a page already bookmarked in the synchronized scope cannot be quick-added again.
- Quick add opens the shared inline form with the current URL/title and selected writable folder. Native creation still requires an explicit confirmation. It never creates reading items.
- The separate full-page button opens `bookmarks.html?folder=...` in the owning window. Close the side panel only after tab creation succeeds and only if the browser supports `sidePanel.close`. A failed handoff leaves the side panel available for retry.

## Automatic Previews

- Connecting or refreshing the native mirror reconciles a device-local durable preview queue. Entering a view promotes visible entries and starts its next batch immediately; an alarm continues remaining work every 30 seconds, including after worker/browser restarts.
- Each batch handles at most 12 pages through a shared two-job limiter. Queueing thousands of identities does not launch thousands of requests. Duplicate requests for an in-flight node share work, and incomplete/failed previews wait 24 hours before the next automatic attempt.
- Cache eviction keeps usable covers ahead of failure records and preserves at most 144 currently visible identities ahead of background covers. Those pins survive worker restarts. Entering another view can immediately restore an evicted successful preview; redraws within the same view do not cycle successful images through an exhausted byte budget.
- Loaded tabs use the same extractor and server-rescue decisions as normal reading saves, with a bounded metadata provider. Static HTML uses the shared parser, and known reading cover URLs are downloaded before another HTML request. No tabs are opened, navigated, activated, resumed or closed.
- Preview fetches omit credentials, use an eight-second abort deadline and cap streamed HTML at 256 KiB and images at 4 MiB. Covers are resized to at most 1024 pixels and 512 KiB. The local preview cache remains limited to 300 records and 8 MiB, separate from native bookmarks and reading backups/WebDAV.
- Fetch follows redirects as normal reading covers do, because browser manual redirects do not expose their Location. Initial and final addresses are checked for recognizable local/private/credential-bearing URLs; intermediate redirects and DNS resolution cannot be validated before the browser requests them. This is not network-level isolation.
- Permission/scope changes cancel fetches and invalidate the generation before commit. Native bookmark identity and URL are checked again before storing results. There is no manual “load missing previews” control.

## Verification

- DOM/native fixtures cover in-panel destinations, no implicit tab creation, both languages, native creation and reading isolation, independent view state, tab races, other windows, unsupported URLs, failed handoffs, folder context and surface-aware transfers.
- Rebuild the offline UI with `node tests/build-bookmark-preview.js`, then open `/private/tmp/lateron-library-redesign/bookmarks.html?surface=sidepanel`. Add `&theme=dark&language=en` for the English dark variant. All native bookmark, tab and network operations in this fixture are fake; previews are synthetic.
- Browser fixture checks do not establish real-profile extension installation, native Chrome side-panel navigation/closing, permission prompts or personal bookmark writes. Those remain platform acceptance boundaries.

Release QA (2026-11-02): all 72 test files pass. Chromium fixture screenshots and measurements cover Chinese light at 280/320/400px and English dark at 280/420px, with no document-level horizontal overflow or vertically clipped bookmark titles. Nested navigation, descendant search, explicit current-page confirmation, menu/form layout and full-page handoff counters were exercised; entering the surface leaves the created-tab counter at zero.

Implementation QA (2026-11-04): all 83 test files pass, runtime JavaScript syntax checks pass, and the 59-file test package includes both new shared controllers. Chromium fixtures verify twenty repeated switches with the same frame, documents and search inputs, and a delayed initial bookmark response leaves the reading view visible until completion. Light 320px and dark 280px sidebars plus the 1100px reading library show no document-level horizontal overflow. Separate fixtures cover a 1,000-bookmark cache, two preview workers, twelve-job batches, restart, eviction, cooldown and reuse of known reading covers even when HTML is unavailable. These checks use synthetic/native-API fixtures; real extension installation and live-site/CDN acceptance remain unverified.

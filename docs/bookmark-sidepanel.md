# Bookmark Side-Panel Surface

The reading side-panel switch navigates to `bookmarks.html?surface=sidepanel` in its own browsing context. It has no `_blank` target. The reverse switch returns to `sidepanel.html`; transfers from reading items also keep the originating surface. Normal full-page bookmark URLs retain the desktop layout.

## Shared Logic, Different Layout

- `bookmark-sidepanel.js` selects the surface before paint and enables the actual reading side-panel base CSS plus bookmark-specific compact overrides. It mounts the existing bookmark DOM into a compact navigation/search/current-page/list layout, rather than embedding a narrow desktop page or duplicating native mutation logic.
- `bookmarks.js`, `bookmark-view.js`, native synchronization, permissions, confirmation dialogs and preview data remain shared. No bookmark mutation is performed merely by entering the side panel.
- Folder previews become horizontally scrollable compact chips; the hierarchy is an inline, collapsed navigator. Bookmark cards use the reading side panel's 92px thumbnail and vertical-list proportions. No read/unread or cleanup controls are introduced.
- The compact view uses `laterOnBookmarkSidepanelView`; the desktop continues to use `laterOnBookmarkView`. Both remain device-local and excluded from reading backups, cleanup and WebDAV.

## Current Page And Full-Page Handoff

- Read the active tab in the current browser window; do not fetch page metadata, remote images or favicons. Reuse a matching cached bookmark cover when available.
- Ignore stale queries and changes from other windows. Queries have a four-second deadline. Only HTTP(S) pages can be added; a page already bookmarked in the synchronized scope cannot be quick-added again.
- Quick add opens the shared inline form with the current URL/title and selected writable folder. Native creation still requires an explicit confirmation. It never creates reading items.
- The separate full-page button opens `bookmarks.html?folder=...` in the owning window. Close the side panel only after tab creation succeeds and only if the browser supports `sidePanel.close`. A failed handoff leaves the side panel available for retry.

## Verification

- DOM/native fixtures cover in-panel destinations, no implicit tab creation, both languages, native creation and reading isolation, independent view state, tab races, other windows, unsupported URLs, failed handoffs, folder context and surface-aware transfers.
- Rebuild the offline UI with `node tests/build-bookmark-preview.js`, then open `/private/tmp/lateron-library-redesign/bookmarks.html?surface=sidepanel`. Add `&theme=dark&language=en` for the English dark variant. All native bookmark, tab and network operations in this fixture are fake; previews are synthetic.
- Browser fixture checks do not establish real-profile extension installation, native Chrome side-panel navigation/closing, permission prompts or personal bookmark writes. Those remain platform acceptance boundaries.

Release QA (2026-11-02): all 72 test files pass. Chromium fixture screenshots and measurements cover Chinese light at 280/320/400px and English dark at 280/420px, with no document-level horizontal overflow or vertically clipped bookmark titles. Nested navigation, descendant search, explicit current-page confirmation, menu/form layout and full-page handoff counters were exercised; entering the surface leaves the created-tab counter at zero.

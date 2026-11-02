# Bookmark Library

## Product Contract

- A dedicated Bookmarks / 书签库 area is separate from temporary reading items.
- The native browser bookmark tree is authoritative. Browser events refresh a device-local view; writes in LaterOn use the native API. There is no echo-write reconciliation or URL-based identity mapping.
- Synchronization is opt-in using the optional bookmarks permission. Its scope defaults to all bookmarks, or a chosen folder and descendants.
- Scope changes, disabling, permission loss, startup and cache refresh never delete browser data. A missing scoped folder blocks operations rather than falling back to all bookmarks.
- Every mutation fetches and validates the latest native tree and scope. Native root folders and managed nodes cannot be modified; moving a folder into itself or its descendants is forbidden.
- Bookmark deletes require an explicit confirmation in the UI. Non-empty folders cannot be deleted from LaterOn; use the browser bookmark manager for recursive deletion.
- Native node IDs are device-local. Bookmark state/config are not included in the reading library, its backups, WebDAV, wipe, or auto-clean.
- Copying temporary reading items into the bookmark library preserves their originals. The resulting native bookmarks survive removal of their temporary reading copies.
- Bulk copies revalidate the current scope and destination before every native create: the browser can move folders while a transfer is running. Return added/existing counts, successful source IDs and per-item failures; retries deduplicate against the latest target folder.
- A successful native write stays committed even if the local view refresh fails. Return a committed result with an explicit refresh warning instead of encouraging blind retries.
- Derive protected root folders from tree structure as well as folderType (which is newer than Chrome 121). Managed protection propagates through ancestors; root folders may accept children but cannot themselves be mutated.
- Register bookmark wake-up listeners synchronously, reattach on permission grant, block writes on revocation, and refresh on worker/browser startup. Coalesce queued native events and refresh once browser imports end.

## Implementation And Verification

1. Background adapter: serialized native writes, fresh scope enforcement, event-driven cached view, permission/startup/error recovery.
2. Dedicated responsive page: folder navigation/search, scope selection, enable/disable, add/edit/move/delete URLs, create/rename/delete empty folders.
3. Library and side-panel entry points; single/bulk temporary-item transfer.
4. Isolated native-API tests for bidirectionality, scope, root/managed protections, concurrency, failures/restarts, and reading-data isolation; DOM tests and isolated browser previews.
5. Full regression suite, reproducible release ZIP, separate commit/tag/release after 1.69.0.

Official API references:
- https://developer.chrome.com/docs/extensions/reference/api/bookmarks
- https://developer.chrome.com/docs/extensions/reference/api/permissions

Real user bookmarks must not be modified during automated verification. Native permission prompts and real-profile installation remain a manual acceptance boundary.

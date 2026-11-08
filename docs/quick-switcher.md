# Quick Switcher

Quick Switcher searches open tabs, Reading and connected Bookmarks in one compact dialog. Use the LaterOn launcher or the configured shortcut, normally Alt/Option+O. Results show a title, a smaller address/location line, a website icon and badges for the sources included in the selected mode. The dialog follows LaterOn's light/dark theme and keeps the selected result visible when resized.

## Four search modes

Every new opening starts in the configured Default mode. The initial configuration is:

| Mode | Trigger inside the search field | Initial sources |
| --- | --- | --- |
| Default / All | Open Quick Switcher | Tabs + Reading + Bookmarks |
| Tabs | Tab | Tabs |
| Reading | Space at the beginning | Reading |
| Bookmarks | Apostrophe (`'`) at the beginning | Bookmarks |

The four visible mode controls also work with a mouse or normal button focus. Their labels and the scope hint reflect the configured sources. Switching with a button or Tab preserves the current query. Each reopening starts in Default rather than retaining the previous mode.

Plain Tab selects whichever mode currently has the Tab trigger, while focus is in the search field. If no mode uses Tab, it remains focus navigation within the dialog. Shift+Tab always retains normal focus navigation.

Printable triggers are recognized only at the beginning of user input, including pasted input. For example, `'quantum dots` selects Bookmarks and searches for `quantum dots`; a leading space selects Reading. Optional whitespace after a pasted/custom trigger is removed so it cannot become a second trigger. Spaces between ordinary search words remain part of the query. Input-method composition is left intact until composition ends; IME Enter does not open a result.

Backspace in an empty query returns to Default. Changing mode configuration preserves the current query and selected stable mode; it updates that mode's sources and trigger without interpreting existing text as a new trigger. Mode or configuration changes cancel old results and pending Enter confirmation, so a result from the previous scope cannot be opened accidentally.

## Configure sources and triggers

Open Settings and find **Quick Switcher search modes** (「快速切换搜索模式」). Each of the four rows can use any nonempty combination of Tabs, Reading and Bookmarks: three single-source choices, three pairs, or all three. The initial labels are defaults, not fixed source restrictions.

Default has no input trigger. The other three rows support Tab, Space or a custom printable prefix of 1–8 characters. Choose distinct prefixes; empty, conflicting or unsupported triggers cannot be saved. A prefix is recognized at the beginning of fresh input, so a punctuation prefix is useful when a word prefix would overlap ordinary search terms.

Edits remain a draft until **Save**. Save applies the four rows together. **Reset** restores the default draft; press Save to make that reset take effect. Saved changes update an open switcher without closing it or discarding its query. Search-mode changes do not rebuild the library indexes.

## Search sources and website icons

Tabs are read live from accessible browser windows. They are session data and are not copied into Reading, Bookmarks, backups or synchronized indexes. Reading search includes saved reading states and archived projects. Bookmarks search uses the currently enabled synchronization scope and current browser permission.

Source filtering happens before result limits and counts. Results are deduplicated by their complete URL, preserving query strings and fragments. A URL present in more than one selected source can have multiple badges; excluded sources and their project/folder context are not shown. Custom Reading titles remain searchable.

Website icons use Chrome's cached favicon endpoint where available. The dialog requests icons for the displayed result slice as rows become visible, and never waits for image loading before accepting input or showing results. It does not load cover images or hydrate the whole preview library for icons. If a favicon is unavailable or fails, a transparent site-letter or globe placeholder remains. An icon's appearance depends on the browser cache; a particular website's real icon is not guaranteed.

## Select and open

- Up/Down selects a result; Enter opens or switches to it.
- Library results normally reuse an existing tab with the exact URL. Command/Control+Enter requests a new tab for a library result.
- Tab-only results activate the verified existing tab, including browser pages that cannot be injected with content scripts. Their titles and addresses are displayed as safe text.
- Escape closes the dialog and restores the previous page focus.

Opening rechecks the current source membership. Tab IDs and their current URLs are checked again, so a closed or navigated tab-only result cannot recreate an obsolete page. Bookmark actions also recheck native ID, complete URL, permission and synchronization scope. Cached results never grant permission or expand the selected sources. Failed searches expose retry, and failed opening leaves the dialog available for another selection.

On ordinary web pages the dialog uses a closed shadow root and the extension's keyboard guard. Browser pages that cannot host injected content use the same component in a small extension-owned popup. Closing that popup affects only the search window or its own tab. Mode triggers operate inside the dialog and do not add browser-wide default shortcuts. Existing web pages need a refresh after extension reload to load changed content scripts; Settings show the browser's actual shortcut assignments.

## Validation status

This document describes release `1.74.4`. Its runtime matches the accepted `1.74.4-test.1` build; the formal release removes the test display label. Earlier 1.74.3 startup reports cover the earlier implementation. The current [validation record](quick-switcher-validation.md) includes this build's native evidence, regression reports and limits.

All 114 test files pass. Controlled browser checks cover mode/source combinations, leading prefixes and ordinary spaces, pasted input, IME, configuration changes, stale queries and confirmation, icon loading/failure, focus restoration and narrow layouts. An isolated native Chrome profile with 50k Bookmarks and 5k Reading passes 20 checks, including seven source combinations, live-tab actions, real settings persistence, a cached local-site favicon and schema-5 repair.

With its index prepared, the native test's first usable rows appeared in 14.5–63.6 ms with a running worker and 76.7–86.7 ms after forcing the worker to stop. Initial full preparation took 38.8 seconds. OS shortcut behavior, the user's actual profile, protected-page popup and every remote website icon remain outside this native run. Input readiness, first rows, search and opening are recorded separately.

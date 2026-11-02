# Shared Presentation Contract

## Foundations

`theme-vars.css` owns the UI font stack, semantic font weights, colors, title/body line heights, focus treatment and icon stroke. Use regular 400, medium 500, semibold 600, bold 700 and brand 800 rather than slightly different per-page weights. Site-cover initials remain content placeholders, not UI typography.

Declare cascade layers in this order: critical, base, library, bookmarks, navigation, settings, sidepanel, bookmark-panel, dialogs, onboarding. Component layers override base resets; compact bookmark adaptations override desktop bookmark rules. Avoid `font: inherit` resets outside the base layer, and do not use font-size `!important` to compensate for an incorrect layer. Hidden elements and reduced-motion preferences are deliberate exceptions to normal priority.

## Sidebar Components

- Both documents use `sidepanel-surface`, the shared `sidepanel.css`, and `library-navigation.css`. Bookmark-specific rules belong in `bookmark-sidepanel.css` and should not duplicate common current-page/button typography.
- Compact headers are 58px tall, with 13px content gutters and 14px top spacing. At 620px, the shared header becomes 64px with 22px gutters and 20px top spacing.
- The current-page card uses a 52px thumbnail, 12px bold title, 10px source, and 11px bold action label. The wide form uses a 64px thumbnail and 13px title.
- Both save buttons use `current-save`, `save-mark`, `save-add`, `save-check`, and `save-label`. Toggle the `saved` class and update the label/accessible name; never replace the button's entire text or write a font-dependent plus/check character into its icon container.
- Saved state is not a presentation preference. Each library determines membership independently; the shared page-facts cache does not supply it.
- Shared navigation, current-page information and search remain outside the reading collection's loading skeleton. The reading save action remains disabled until actual reading data establishes membership.
- Card typography, borders and hover/focus controls share the same compact scale; bookmark paths, counts, folder navigation and the absence of read state are intentional domain differences.

## First Paint

Every extension document loads `appearance.js` before styles/body rendering. It restores only theme and language, preferring session storage and falling back to a small local preference cache. `theme.js` calibrates these hints against Chrome settings and ignores superseded initial reads. No reading items, bookmarks, identifiers or membership flags enter this cache.

Core sidebar styles are render-blocking. Only optional onboarding styles remain deferred. Critical fallback styles use the same palette/font stack in the lowest-priority layer; they must not override final header geometry through ID specificity. The ordinary settings read remains authoritative, including on first use when no appearance cache exists.

## Motion

Do not replay opacity/translate entry animations whenever lists or boards are rebuilt. Keep purposeful hover, dialog and drag feedback, and respect reduced-motion preferences globally. Reserve layout space rather than swapping whole common controls for placeholders.

## Acceptance Boundary

The 1.74.0 changes were prepared without running browser or automated tests, as requested. Native sidebar switching, first-paint behavior, platform font rendering, dark/light themes, narrow/wide widths and touch/keyboard behavior remain for user acceptance.

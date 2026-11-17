# MarkText: why there is no adapter

Decision for P4: **no MarkText adapter**. MarkText (`dsh-marktext` 0.1.13) never opens a file in this profile, so there is
nothing to attach to. Verified in the dev GUI on 2026-11-14 with DSH 0.2.2-rc.3 and dsh-better-sidebar 0.32.1.

## What was checked

| File | Viewer that opened it | Evidence |
|---|---|---|
| `notes.md` | better-sidebar editor (Preview / Edit toggle) | native DOM, no `<iframe>` |
| `test.markdown` | better-sidebar editor (Preview / Edit toggle) | same |
| `test.mkd` | better-sidebar editor in plain CodeMirror (the `code` catch-all) | line gutter, no preview |
| `test.mdown` | better-sidebar editor (same path as `.markdown`) | same |

MarkText renders inside a same-origin `<iframe src="/dsh-marktext/renderer/<token>/index.html">`. No tab in any test had one.

## Why

The right sidebar picks a viewer for an address by (1) priority band, (2) **length of the longest matching glob**, (3) registration
order (`tab-registry.ts` `candidates()`, DSH 0.2.2-rc.3). Both plugins use the `extension` band, and:

- better-sidebar's editor claims `dsh-resource://file/**` (22 characters),
- MarkText claims `*.md`, `*.markdown`, `*.mdown`, `*.mkd` (4 to 10 characters).

The longer pattern wins, so better-sidebar's editor beats MarkText for every Markdown file. better-sidebar's `canOpen` only steps
aside for formats DSH's own previews own (pdf, office, images), and Markdown is not one of them. MarkText also registers no guide
entry and no "open with" route, so a user cannot pick it either.

## When this changes

Re-check when any of these happens: better-sidebar stops claiming `dsh-resource://file/**`, MarkText registers a longer or more
specific pattern, or DSH changes the ranking. A quick test: open a `.md` file in the Files tree and look for an `<iframe>` in the
tab body.

## If MarkText becomes reachable

MarkText talks to the page over `postMessage` (envelope `__dshmkt`; up types `ready/save/reload/insert-chat/save-pdf/open-link/open-external`)
and its muya selection lives in the iframe document. The iframe is same-origin, so a DOM adapter could read
`frame.contentDocument.getSelection()`; the better-sidebar adapter in `src/client/adapters/bettersidebar.ts` is the model. A cleaner
route is an upstream `comment` up-message with a block index; see `docs/upstream-better-sidebar-selection.md` for the equivalent ask.

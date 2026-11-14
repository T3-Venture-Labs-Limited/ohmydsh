# Upstream ask: a selection hook in dsh-better-sidebar's file viewers

Target: `omdsh-dev/DSH-better-sidebar` (checked against 0.32.1). Goal: let other plugins (here `dsh-review-comments`) act on a
text selection in better-sidebar's editor and markdown preview **without reading its DOM**, so we can delete
`src/client/adapters/bettersidebar.ts`.

## What we do today (and why it is fragile)

`dsh-review-comments` captures selections in better-sidebar's viewer by reading its DOM:

| Need | Today's workaround | Why it breaks |
|---|---|---|
| Know a selection is inside a better-sidebar file tab | `closest('[data-dsh-native-tab-host]')` | An e2e marker, not a contract |
| Which file | public `sidebarRight.openTabs` inventory (good), else the header path `<input>` | the input fallback depends on markup |
| Exact lines in the editor | `.cm-content.cmTile.root.view` → `EditorView.posAtDOM()` | `cmTile` is a CodeMirror private; it was `cmView` before 6.43 |
| Lines in the markdown preview | none in the DOM; we re-read the file through the workspace Remote and search for the quote | heuristic, approximate |
| Highlights | CSS Custom Highlight ranges over the editor's text nodes | CodeMirror virtualises lines, so ranges are re-resolved on every mutation |

## Proposed API

Extend `ctx.betterSidebar` (the service already exposes `registerTab/FileViewer/FileAction/TabAction`):

```ts
interface SelectionInfo {
  /** Same `dsh-resource://file/...` address the tab was opened with. */
  address: string
  sessionId: string
  path: string
  /** Exact selected text as the viewer's source, not the rendered text. */
  text: string
  /** 1-based inclusive source lines. Editor: exact. Markdown preview: from the markdown AST positions (mdast `position`). */
  lines: { start: number; end: number }
  mode: 'editor' | 'preview'
  /** Viewport rectangle of the selection end, for positioning a floating control. */
  rect: DOMRectReadOnly
  /** Version of the document the lines refer to (mtime), so callers can detect drift. */
  version?: number
}

interface BetterSidebarSelection {
  /** Fires on every non-empty selection change in any of the plugin's file viewers; `null` when it collapses. */
  onSelection(listener: (selection: SelectionInfo | null) => void): () => void
  /** Optional: paint a persistent highlight the viewer keeps in sync (survives virtualisation and mode switches). */
  setHighlights(owner: string, ranges: readonly { address: string; start: number; end: number; tone?: 'comment' | 'active' }[]): () => void
}
```

Notes:

- The editor already computes everything for its own "Add to conversation" popup (`selectionInsertOf(path, cwd, lines, text)` in
  `TextEditor.tsx`, `doc.lineAt(...)`). Publishing the same payload on the service is a small change.
- For the markdown preview, `MarkdownText` is fed `previewText`; carrying `data-source-line` attributes (or mdast `position`) on block
  elements would give real line spans instead of a heuristic search.
- `setHighlights` is optional; without it we keep using the CSS Custom Highlight API.
- Read-only: no way to write the document through this hook.

## What we would delete once it ships

`adapters/bettersidebar.ts` (about 160 lines), the `.cm-content.cmTile` access, the header-input path fallback and the markdown
line-search round trip for this viewer. The feature flag `localStorage['dsh-review-comments:better-sidebar'] = 'off'` stays for users who
want the plugin to ignore better-sidebar entirely.

## Not asked for

Changing the editor's own popup, or any write access to viewer DOM.

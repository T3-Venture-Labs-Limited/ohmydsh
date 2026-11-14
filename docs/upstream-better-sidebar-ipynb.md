# Upstream request: let notebook plugins own `.ipynb` in dsh-better-sidebar

Target: [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (tested against 0.32.1). Draft issue / PR description; not yet filed.

## Problem

better-sidebar registers its file editor as a catch-all in the `extension` band
(`src/client/native/index.ts`, around line 480):

```ts
patterns: ['dsh-resource://file/**'],
canOpen: (address) => { const file = parseFileAddress(address); return file !== undefined && !hostOwnedPath(file.path) },
```

`hostOwnedPath` (line 88) only refuses the extensions in `HOST_OWNED_EXTS` (xlsx, csv, pdf, images, Office), the ones DSH's own previews handle.

The sidebar's tab registry ranks candidates by **priority band, then by the length of the longest matching pattern, then by registration order**
(`SidebarRightTabRegistry.candidates`). Consequences for any other extension plugin that wants a file type, such as a notebook viewer:

- A plugin that registers the natural pattern `*.ipynb` (7 characters) **loses** to `dsh-resource://file/**` (22 characters) in the same band, so clicking a `.ipynb` opens the CodeMirror editor, not the notebook.
- The only way to win today is a pattern longer than 22 characters, such as `dsh-resource://file/**/*.ipynb`. That is an accident of string length, not a contract, and every plugin author has to rediscover it.
- `claimingNativeKind` (line ~4440 of the bundle) does hand a file to another type when one ranks first, but only for the open paths that call it, and it never changes the registry ranking itself.

## Proposal

Smallest change: treat file types that a *more specific* tab type exists for as not owned by the editor. Either:

1. **Denylist (one line).** Add `ipynb` to `HOST_OWNED_EXTS` (or a sibling `ELSEWHERE_EXTS` set) so `canOpen` returns false for `.ipynb`. Plugins that register `*.ipynb` then win regardless of pattern length. Without a notebook plugin installed, `.ipynb` would fall to the built-in text preview, which renders JSON acceptably; if that is a regression for users, see option 2.
2. **Probe instead of denylist.** In `canOpen`, ask the registry whether another type in the `extension` or `builtin` band matches the address by a non-catch-all pattern, and decline if so. This keeps `.ipynb` in the editor when no notebook plugin is present and generalizes to `.drawio`, `.excalidraw`, `.mmd` and similar.

Option 2 sketch:

```ts
canOpen: (address) => {
  const file = parseFileAddress(address)
  if (file === undefined || hostOwnedPath(file.path)) return false
  const other = ctx.get('sidebarRightTabs')?.candidates(address).find((t) => t.kind !== EDITOR_KIND && !t.patterns?.includes('dsh-resource://file/**'))
  return other === undefined
},
```

(`candidates` skips types whose own `canOpen` vetoes, so this cannot recurse into the editor.)

## Why it is safe

- No change for any file type nobody else claims.
- `claimingNativeKind` keeps working; it already expresses the intent "another type may own this file".
- Behaviour with dsh-notebook installed: the notebook plugin already wins today through its 30-character pattern, so this change removes the length race rather than altering results.

## Evidence

- Registry source: `dsh-client-ui-sidebar-right/src/client/tab-registry.ts` (`candidates`, `RANKS`, `matcherFor`).
- Verified with picomatch that `dsh-resource://file/**/*.ipynb` matches `.../a.ipynb` and `.../B.IPYNB` (nocase) and not `.../a.ipynb.bak`.
- Verified live in the DSH 0.2.2-rc.3 dev harness with better-sidebar 0.32.1 installed: clicking `demo.ipynb` in the Files tree opens the dsh-notebook tab.

## Compatibility note for dsh-notebook

dsh-notebook keeps `dsh-resource://file/**/*.ipynb` as its pattern either way, so it works with old and new better-sidebar versions.

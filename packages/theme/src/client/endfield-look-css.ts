// The Endfield look: the stylesheet half (tokens: src/shared/endfield-look.ts). A port of the parts of
// dsh-theme-endfield (MIT, github:ymh0000123/dsh-theme-endfield, see NOTICE) that show with its default settings. Glass
// (the translucent composer, sidebar and right panel) is its own setting now: src/client/glass-css.ts. This sheet is mounted
// only while the look is on, so no rule needs a `body.x` / `body[data-ds-dark-theme]` prefix, and dark/light differences come from the token layer (or the DARK/LIGHT parts below, chosen by palette mode).
//
// Cost rules, enforced by tests/endfield-look.spec.ts. They are why typing stays as fast as with no theme at all:
//   - no `:has()`                     (re-checked on DOM changes; a streaming reply changes the DOM every frame)
//   - no `body …` ancestor prefixes   (each one walks every matched element up to <body>)
//   - no `X *` / `X > *` descendants  (matches every element, then walks its ancestors); text inside a filled element
//                                      follows it by re-pointing the label tokens on that element instead
//   - nothing measures layout: the wordmark is a pseudo-element of the hero headline, positioned by CSS alone.
// Not carried over: Endfield's smooth "output scroll" animation, the boot loader, the big-text and balance extras (all off
// by default there), the full-width approval band and confirmation dialog redesign.

/** Text inside a filled element: re-point the label tokens on the element; descendants inherit them. */
const ink = (value: string): string => [
  `color: ${value} !important`,
  `--dsw-alias-label-primary: ${value}`,
  `--dsw-alias-label-secondary: ${value}`,
  `--dsw-alias-label-tertiary: ${value}`,
  `--dsw-alias-label-caption: ${value}`,
  `--dsw-alias-brand-primary: ${value}`,
].join('; ')

const COMMON = `
/* Square corners: every element, then circles that are circles by nature. */
[class], button, input, textarea, select, [role="button"], [role="dialog"], [role="menu"], [role="tooltip"], [role="tab"] { border-radius: 0 !important }
[class*="vatar"], [class*="pinner"], [class*="dot" i], [class*="actionButton" i], [class$="_iconButton"] { border-radius: 50% !important }
button, [role="button"] { transition: none !important }
* { scrollbar-width: thin; scrollbar-color: var(--edge-line) transparent }

/* Signal details. */
::selection { color: var(--edge-on-accent); background: var(--edge-accent) }
input, textarea, [contenteditable="true"] { caret-color: var(--edge-caret) }
:focus-visible { outline: 2px solid var(--edge-focus-ring) !important; outline-offset: 1px }
a { text-decoration-thickness: 1px }
a:hover { text-decoration-color: var(--edge-accent); color: var(--edge-link-hover) }
:is([data-width-handle], [class*="_widthHandle"])::after {
  background: linear-gradient(to bottom, transparent calc(var(--dsh-width-handle-pointer-y, 50%) - 36px), var(--dsw-alias-label-primary) calc(var(--dsh-width-handle-pointer-y, 50%) - 8px), var(--dsw-alias-label-primary) calc(var(--dsh-width-handle-pointer-y, 50%) + 8px), transparent calc(var(--dsh-width-handle-pointer-y, 50%) + 36px));
}

/* The hero wordmark: drawn behind "Into the Unknown" by CSS alone (Endfield re-measured the headline every frame). */
[class*="_composerHero"] [class$="_headline"] { position: relative; isolation: isolate }
[class*="_composerHero"] [class$="_headline"]::before {
  content: "ENDFIELD"; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: -1;
  pointer-events: none; user-select: none; white-space: nowrap; line-height: 110px;
  font-family: Arial, "Helvetica Neue", sans-serif; font-weight: 900; font-size: 9.5vw; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--dsw-alias-label-primary); opacity: var(--edge-wm-alpha);
}
[class*="_heroGlow"] ellipse { fill: var(--edge-accent) !important; fill-opacity: var(--edge-glow) !important }

/* Solid accent controls. */
[class$="_newSession"] { ${ink('var(--edge-on-accent)')}; background: var(--edge-accent) !important; border-color: var(--edge-accent) !important }
[class$="_newSession"]:hover, [class$="_newSession"]:focus-visible { background: var(--edge-accent-deep) !important; border-color: var(--edge-accent-deep) !important }
[class$="_newSession"] svg { color: var(--edge-on-accent) !important }
[class*="brand"] svg rect, [class$="_newSession"] svg rect { fill: var(--edge-accent) !important }
[class*="_previewBadge"] { color: var(--edge-on-accent) !important; background: var(--edge-accent) !important; border-color: var(--edge-accent) !important }
[class$="_trigger"]:hover:not(:disabled), [class$="_trigger"][aria-expanded="true"], [class$="_trigger"]:focus-visible { ${ink('var(--edge-on-accent)')}; background: var(--edge-accent) !important }
[class$="_headerActions"] [class*="_label"] { ${ink('var(--edge-on-accent)')}; background: var(--edge-accent) !important; padding: 0 12px !important }
[class*="_selected"] { border-color: var(--dsw-alias-border-l2) !important }

/* Sidebar: accent folder/chevron icons; hovered, selected and menu-open rows filled. */
[class$="_sidebarCol"] [class*="_slot"] { color: var(--dsw-alias-brand-primary) !important }
[class*="_sessionRow"]:hover, [class*="_projectRow"]:hover, [class*="_searchResultRow"]:hover,
[class*="_sessionRow"][class*="_selected"], [class*="_sessionRow"][class*="_menuOpen"], [class*="_searchResultRow"][class*="_selected"] {
  ${ink('var(--edge-row-ink)')}; background: var(--edge-row-fill) !important; border-inline-color: var(--edge-row-fill) !important;
}

/* Composer: accent "+" and send/stop. */
:is([data-composer-seat], [class$="_composerSeat"], [class$="_composerHero"]) [class*="_add"] { color: var(--edge-icon) !important }
:is([data-composer-seat], [class$="_composerSeat"], [class$="_composerHero"]) [class*="_add"]:hover:not(:disabled) { ${ink('var(--edge-icon-hover-ink)')}; background: var(--edge-icon-hover-fill) !important }
:is([class$="_composerSeat"], [class$="_composerHero"]) button[class*="_primary"] { color: var(--edge-primary-ink) !important }

/* Icon buttons (plus / ellipsis / stop / actions). */
[class$="_iconButton"], [data-cordis-switch] { color: var(--edge-icon) !important }
[class$="_iconButton"]:hover:not(:disabled), [data-cordis-switch]:hover:not(:disabled) { ${ink('var(--edge-icon-hover-ink)')}; background: var(--edge-icon-hover-fill) !important }

/* Plugin approval buttons. */
[data-cordis-approve], [data-cordis-approve-plugin] { ${ink('var(--edge-on-accent)')}; background: var(--edge-accent) !important }
[data-cordis-approve] svg, [data-cordis-approve-plugin] svg, [data-cordis-decline] svg { fill: currentColor !important }
[data-cordis-approve]:hover:not(:disabled), [data-cordis-approve-plugin]:hover:not(:disabled) { background: var(--edge-accent-deep) !important }
[data-cordis-decline] { ${ink('var(--dsw-alias-label-on-color)')}; background: var(--dsw-alias-state-error-primary) !important }

/* Tables and badges. */
th { background: var(--edge-soft) !important; border-bottom-color: var(--edge-line) !important }
td { border-bottom-color: var(--edge-line) !important }
tbody tr:hover > td, tbody tr:hover > th { color: var(--dsw-alias-label-primary) !important; background: color-mix(in srgb, var(--edge-accent) 15%, var(--dsw-alias-bg-base)) !important }
[class*="_badge" i]:hover, [class*="_badge" i][data-active] { ${ink('var(--edge-row-ink)')}; background: var(--edge-row-fill) !important }
[class*="_colorMessages"] { --meter-tint: var(--edge-accent) !important }
[class*="_colorSystem"] { --meter-tint: var(--dsw-alias-label-tertiary) !important }
`

/** Dark palettes: Endfield's solid-accent inversions. */
const DARK = `
[class*="selected" i]:not([class*="unselected" i]) { ${ink('var(--edge-on-accent)')}; background: var(--edge-accent) !important; border-color: var(--edge-accent) !important }
[class*="_badge" i]:hover, [class*="_badge" i][data-active] { background: var(--edge-accent) !important }
[class$="_compactionRow"] { background: color-mix(in srgb, var(--edge-accent) 8%, transparent) !important; border-left: 2px solid color-mix(in srgb, var(--edge-accent) 55%, transparent) !important }
[class$="_compactionButton"]:hover:not(:disabled), [class$="_compactionButton"]:focus-visible { ${ink('var(--edge-on-accent)')}; background: var(--edge-accent) !important }
`

/** Light palettes: keep ink on paper. */
const LIGHT = `
[class$="_switch"][data-on]::after { background: var(--dsw-alias-bg-layer-1) !important }
`

export function endfieldLookCss(mode: 'light' | 'dark'): string {
  return COMMON + (mode === 'dark' ? DARK : LIGHT)
}

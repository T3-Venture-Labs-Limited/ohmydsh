// Glass: the stylesheet half (setting and tiers: src/shared/glass.ts, numbers: src/artwork/glass-tiers.ts). Tier values are
// dsh-theme-endfield's (MIT, see NOTICE), ported as one small stylesheet that is mounted only while glass is on.
//
//   composer card         translucent fill + sheen + accent glow, NO backdrop-filter. A backdrop-filter makes the element
//                         the containing block of its position:fixed descendants; the send-button tooltip is fixed, so
//                         blurring the card moved the tooltip and made it re-measure in a loop (layout jitter).
//   docked right panel    the same fill and the real backdrop blur, but only while it is open: the panel div stays in
//                         the DOM when collapsed, so frosting it unconditionally would leave a glass slab over the page.
//                         The dock pane inside it paints its own opaque background, which would hide all of that, so while the
//                         panel is open the pane is transparent (a 3-attribute selector out-ranks its single class: no !important).
//   sidebar               sheen and an inset edge only (its own fill is left alone).
//   fallbacks             no backdrop-filter support -> a nearly opaque fill; prefers-reduced-transparency -> opaque, no blur.
//
// Colours come from tokens, not from fixed paper/ink values: the fill is the active background token (or, with the Endfield
// look, the look's own `--edge-glass-fill`, which already follows the palette); the glow is the accent. Highlights are white.
// Cost rules are the same as the Endfield look (tests/glass.spec.ts): no :has(), no `body` prefixes, no `X *` descendants,
// nothing animates, nothing measures layout, and `!important` only where DSH's own rule sets the same property on the same
// element (exactly the properties the Endfield look already forced there).
import { GLASS_EDGE, GLASS_FALLBACK_ALPHA, GLASS_SHEEN, GLASS_TIERS, white } from '../artwork/glass-tiers.ts'
import type { Glass } from '../shared/glass.ts'

export interface GlassStyle {
  tier: Exclude<Glass, 'off'>
  /** Light or dark as rendered (the palette's mode, or Appearance with Stock colours). */
  mode: 'light' | 'dark'
  /** The Endfield look is on: fill and accent come from its variables. */
  endfield: boolean
}

const SURFACES = '[data-composer-card], [data-sidebar-right-panel="push"][data-sidebar-right-open]'
const PANEL = '[data-sidebar-right-panel="push"][data-sidebar-right-open]'
const num = (a: number): string => String(Math.round(a * 1000) / 1000)
const pct = (a: number): string => `${Math.round(a * 1000) / 10}%`

/**
 * Fill tokens, one per surface: the composer keeps the colour it has with glass off (its input fill), the panel, which is
 * transparent with glass off, takes the first background layer. The Endfield look supplies its own triplet for both.
 */
export const GLASS_COMPOSER_FILL_TOKEN = '--dsw-specific-input-major'
export const GLASS_PANEL_FILL_TOKEN = '--dsw-alias-bg-layer-1'
/** The accent as the page paints it: the look's own variable, else the token palettes and DSH both set for links and focus. */
export const GLASS_ACCENT_TOKEN = '--dsw-alias-state-business-primary'

export function glassCss({ tier, mode, endfield }: GlassStyle): string {
  const { alpha, blur } = GLASS_TIERS[tier]
  const a = alpha[mode]
  const fill = (v: number, token: string): string => endfield ? `rgb(var(--edge-glass-fill) / ${num(v)})` : `color-mix(in srgb, var(${token}) ${pct(v)}, transparent)`
  /** The composer card and the open right panel, each with its own fill at alpha `v`. */
  const surfaces = (v: number, pad = ''): string => `${pad}[data-composer-card] { background-color: ${fill(v, GLASS_COMPOSER_FILL_TOKEN)} !important }\n${pad}${PANEL} { background-color: ${fill(v, GLASS_PANEL_FILL_TOKEN)} !important }`
  const accent = endfield ? 'var(--edge-accent)' : `var(${GLASS_ACCENT_TOKEN})`
  const sheen = `linear-gradient(145deg, ${white(GLASS_SHEEN[mode])}, transparent 58%)`
  const glow = (percent: number): string => `radial-gradient(ellipse at 0% 0%, color-mix(in srgb, ${accent} ${percent}%, transparent), transparent 75%)`
  return `
${SURFACES} {
  --dsw-elevation-stroke-color: ${white(GLASS_EDGE[mode])};
  background-image: ${sheen}, ${glow(10)} !important;
}
${surfaces(a)}
${PANEL} [data-dockkit-pane] { background-color: transparent }
${PANEL} { -webkit-backdrop-filter: blur(${blur}px) saturate(1.05); backdrop-filter: blur(${blur}px) saturate(1.05) }
[data-slot="sidebar"] > div {
  background-image: ${sheen}, ${glow(8)};
  box-shadow: inset -1px 0 0 ${white(GLASS_EDGE[mode])};
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  ${surfaces(GLASS_FALLBACK_ALPHA, '  ')}
}
@media (prefers-reduced-transparency: reduce) {
${surfaces(1, '  ')}
  ${PANEL} { -webkit-backdrop-filter: none; backdrop-filter: none }
}
`
}

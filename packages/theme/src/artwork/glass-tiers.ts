// Glass tiers, measured from dsh-theme-endfield (MIT, github:ymh0000123/dsh-theme-endfield, see NOTICE) with its `glass`
// setting on subtle / standard / strong. Artwork: the white highlights are light on any palette, and the numbers are
// Endfield's own, so they are data here rather than design decisions in the stylesheet.
//
//   alpha   how opaque the fill is (light / dark palettes); the lower, the more the surface behind shows through
//   blur    backdrop blur of the docked right panel, px (the composer never blurs, see src/client/glass-css.ts)
//   edge    the 1px highlight on the surface edge (white at this alpha)
//   sheen   the soft diagonal highlight laid over the fill (white at this alpha)
//
// Endfield also fixes the fill itself (paper `248 247 240`, ink `31 36 34`); that stays in endfield-own-tokens.ts
// (`--edge-glass-fill`) and is used only with the Endfield look. Any other look derives the fill from the active
// background token.

export type GlassTier = 'subtle' | 'standard' | 'strong'

export interface TierValues {
  readonly alpha: { readonly light: number; readonly dark: number }
  readonly blur: number
}

export const GLASS_TIERS: Readonly<Record<GlassTier, TierValues>> = {
  subtle: { alpha: { light: 0.68, dark: 0.64 }, blur: 8 },
  standard: { alpha: { light: 0.8, dark: 0.76 }, blur: 14 },
  strong: { alpha: { light: 0.9, dark: 0.88 }, blur: 22 },
}

export const GLASS_EDGE = { light: 0.65, dark: 0.18 } as const
export const GLASS_SHEEN = { light: 0.35, dark: 0.07 } as const
/** Fill alpha when the browser cannot blur what is behind (an unblurred see-through panel would hurt legibility). */
export const GLASS_FALLBACK_ALPHA = 0.96

/** White at `a`, as the stylesheet writes it. */
export const white = (a: number): string => `rgb(255 255 255 / ${a})`

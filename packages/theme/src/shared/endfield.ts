// Palette -> extra tokens for pages where dsh-theme-endfield (MIT, github:ymh0000123/dsh-theme-endfield) is also installed.
//
// That plugin paints most of its look from body-scoped `--edge-*` variables (accent, washes, status) and a ramp of
// `--dsw-static-*` / `--dsw-alias-*` declarations in its stylesheet. The theme presenter writes every override-layer token
// as an INLINE property on <body>, which beats a stylesheet rule whatever its specificity, so putting the same names in our
// layer is enough to keep them on the Omarchy palette (and keeps working when endfield flips its yellow/cyan class).
// `--edge-*` names are endfield's own and are only written while endfield is present; `--dsw-*` names are in dsw-defined.txt.
// Endfield's geometry (zero radius) is never touched.
import { alpha, ensureContrast, mix, onColor, parseHex } from './color.ts'
import type { OmarchyPalette } from './omarchy.ts'
import { paletteTokens } from './tokens.ts'
import type { TokenOptions } from './tokens.ts'

export type Layer = Record<string, { light: string; dark: string }>

const A = '--dsw-alias-'
const E = '--edge-'

export function endfieldLayer(palette: OmarchyPalette, options: TokenOptions): Layer {
  const { colors: c, mode } = palette
  const t = paletteTokens(palette, options)
  const get = (name: string): string => t[`${A}${name}`] ?? c.background
  const out: Layer = {}
  const set = (name: string, value: string): void => { out[name] = { light: value, dark: value } }

  const base = c.background
  const accentText = ensureContrast(c.accent, base, 4.5, c.foreground)
  const mid = ensureContrast(mix(c.accent, c.foreground, 0.5), base, 4.5, c.foreground)
  const [r, g, b] = parseHex(c.accent)

  // Endfield's own variables.
  set(`${E}accent`, c.accent)
  set(`${E}accent-rgb`, `${r}, ${g}, ${b}`)
  set(`${E}accent-deep`, mix(c.accent, base, 0.15))
  set(`${E}accent-onpaper`, ensureContrast(c.accent, base, 3, c.foreground))
  set(`${E}status-light`, accentText)
  set(`${E}status-dark`, accentText)
  set(`${E}status-light-mid`, mid)
  set(`${E}status-dark-mid`, mid)
  set(`${E}on-accent`, onColor(c.accent))
  set(`${E}btn-muted`, get('bg-layer-3'))
  set(`${E}focus-ring`, accentText)
  const [lr, lg, lb] = parseHex(get('bg-layer-1').startsWith('#') ? get('bg-layer-1') : base)
  set(`${E}glass-fill`, `${lr} ${lg} ${lb}`)

  // Tokens endfield declares in its stylesheet that our base layer does not carry.
  const wash = (a: number): string => alpha(c.accent, a)
  set(`${A}brand-primary`, mode === 'dark' ? accentText : get('label-primary'))
  set(`${A}bg-primary`, get('bg-layer-1'))
  set(`${A}bg-multi-select`, wash(0.18))
  set(`${A}bg-skeleton`, wash(0.13))
  set(`${A}border-secondary`, get('border-l2'))
  set(`${A}line-secondary`, get('border-l1'))
  set(`${A}separator-primary`, get('border-l4'))
  set(`${A}button-contrast-fill`, get('label-primary'))
  set(`${A}button-elevated-fill`, get('bg-layer-3'))
  set(`${A}button-floating-fill`, get('bg-layer-2'))
  set(`${A}button-floating-hover`, get('bg-layer-3'))
  set(`${A}button-ghost-active-fill`, get('bg-layer-3'))
  set(`${A}button-ghost-active-hover`, mix(get('bg-layer-3'), c.foreground, 0.08))
  set(`${A}button-ghost-active-border`, get('border-l3'))
  set(`${A}fill-l2`, get('bg-layer-3'))
  set(`${A}fill-tsp-secondary`, get('bg-layer-3'))
  set(`${A}interactive-bg-hover-accent`, wash(0.2))
  set(`${A}interactive-bg-hover-solid`, c.accent)
  set(`${A}interactive-bg-primary`, c.accent)
  set(`${A}markdown-citation`, wash(0.18))
  set(`${A}markdown-tag`, wash(0.2))
  set(`${A}state-business-tertiary`, wash(0.18))
  set(`${A}label-inverse`, get('label-primary-inverted'))
  set(`${A}label-primary-bluish`, get('label-primary'))
  set(`${A}label-primary-dimmed`, get('label-secondary'))
  set(`${A}label-quaternary`, get('label-tertiary'))
  set('--dsw-specific-bubble-highlight', get('bg-layer-3'))
  set('--dsw-specific-selector', get('bg-layer-3'))
  set('--dsw-specific-tip', get('bg-layer-3'))
  set('--dsw-specific-sidebar-nav-item-active', wash(0.18))
  set('--dsw-specific-sidebar-nav-item-active-accent', accentText)
  // The static ramp endfield re-declares: neutral steps follow the palette's surfaces and text, 450 is the accent.
  set(`--dsw-static-deepseek-50`, get('bg-layer-3'))
  set(`--dsw-static-deepseek-100`, get('bg-layer-3'))
  set(`--dsw-static-deepseek-200`, mix(get('bg-layer-3'), c.foreground, 0.1))
  set(`--dsw-static-deepseek-300`, mix(get('bg-layer-3'), c.foreground, 0.2))
  set(`--dsw-static-deepseek-400`, get('label-tertiary'))
  set(`--dsw-static-deepseek-450`, accentText)
  set(`--dsw-static-deepseek-500`, get('label-primary'))
  set(`--dsw-static-deepseek-600`, get('label-secondary'))
  set(`--dsw-static-blue-400`, get('label-tertiary'))
  set(`--dsw-static-blue-450`, accentText)
  set(`--dsw-static-blue-500`, get('label-primary'))
  set(`--dsw-static-blue-900`, get('label-primary'))

  // Status colours stay DSH's own unless the "Use Omarchy status colours" switch is on (then the base layer already has them).
  if (options.semanticColors === 'dsh') {
    out[`${A}state-error-primary`] = { light: `var(--dsw-static-red-600)`, dark: `var(--dsw-static-red-400)` }
    out[`${A}label-error`] = { light: `var(--dsw-static-red-600)`, dark: `var(--dsw-static-red-400)` }
    set(`${A}state-warn-primary`, `var(--dsw-static-amber-500)`)
    set(`${A}state-success-primary`, `var(--dsw-static-green-500)`)
  } else {
    set(`${A}label-error`, c.red)
  }
  return out
}

/** Merge the endfield extras over a base layer (extras win per token). */
export function withEndfield(base: Layer, palette: OmarchyPalette, options: TokenOptions): Layer {
  return { ...base, ...endfieldLayer(palette, options) }
}

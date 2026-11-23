// The Endfield look without dsh-theme-endfield: the token half.
//
// The look (square corners, solid accent fills, the hero wordmark, the glass composer) is a port of the visible parts of
// dsh-theme-endfield (MIT, github:ymh0000123/dsh-theme-endfield, see NOTICE). That plugin paints with ~170 KB of CSS whose
// selectors are expensive to match (`:has()`, `body:not(...) [class*=...]` prefixes, `X *` descendants) and positions its
// wordmark with a per-frame layout read; on a streaming reply that doubled the page's work. Here every colour is a token in
// the layer the controller already registers (one inline write on <body>, no selector cost), and the stylesheet
// (src/client/endfield-look-css.ts) only reads them.
import { alpha, ensureContrast, mix, onColor } from './color.ts'
import type { OmarchyPalette } from './omarchy.ts'
import { endfieldLayer } from './endfield.ts'
import type { Layer } from './endfield.ts'
import { paletteTokens } from './tokens.ts'
import type { TokenOptions } from './tokens.ts'
import { ENDFIELD_DARK, ENDFIELD_LIGHT } from '../artwork/endfield-palettes.ts'
import { ENDFIELD_OWN_DARK, ENDFIELD_OWN_LIGHT } from '../artwork/endfield-own-tokens.ts'

export type Look = 'stock' | 'endfield'
export const LOOKS: readonly Look[] = ['stock', 'endfield']
export const isLook = (value: unknown): value is Look => value === 'stock' || value === 'endfield'

/** Endfield's own paper/ink palette, used when the colour source is Stock (for example a phone over the tailnet). */
export function endfieldPalette(mode: 'light' | 'dark'): OmarchyPalette {
  const p = mode === 'dark' ? ENDFIELD_DARK : ENDFIELD_LIGHT
  return { mode: p.mode, colors: p.colors }
}

const A = '--dsw-alias-'

export function endfieldLookLayer(palette: OmarchyPalette, options: TokenOptions): Layer {
  const out = endfieldLayer(palette, options)
  const { colors: c, mode } = palette
  const dark = mode === 'dark'
  const t = paletteTokens(palette, options)
  const get = (name: string): string => t[`${A}${name}`] ?? c.background
  const set = (name: string, value: string): void => { out[name] = { light: value, dark: value } }

  const base = c.background
  const label = get('label-primary')
  const accentText = ensureContrast(c.accent, base, 4.5, c.foreground)
  const onAccent = onColor(c.accent)
  const wash = (a: number): string => alpha(c.accent, a)

  // Variables the stylesheet reads. Everything that differs between a dark and a light palette is decided here, so the
  // stylesheet needs no `body[data-ds-dark-theme]` prefixes.
  set('--edge-line', get('border-l1'))
  set('--edge-soft', get('bg-layer-2'))
  set('--edge-wm-alpha', dark ? '0.085' : '0.13')
  set('--edge-glow', dark ? '0.05' : '0.08')
  set('--edge-caret', dark ? c.accent : label)
  set('--edge-link-hover', accentText)
  // Selected / hovered sidebar rows and other "selected" items: a solid accent in dark palettes, a wash in light ones.
  set('--edge-row-fill', dark ? c.accent : wash(0.22))
  set('--edge-row-ink', dark ? onAccent : label)
  // Icons that Endfield paints in the accent (dark palettes only; light palettes keep ink).
  set('--edge-icon', dark ? c.accent : label)
  set('--edge-icon-hover-fill', dark ? c.accent : wash(0.22))
  set('--edge-icon-hover-ink', dark ? onAccent : label)
  // The composer's send/stop button sits on button-info-fill (accent in dark palettes, ink in light ones).
  set('--edge-primary-ink', dark ? onAccent : onColor(label))

  // Hover, code and scrollbar tints stay the palette's (with dsh-theme-endfield installed our layer already won those, so
  // that is the look people had). Menus take the overlay colour, as Endfield's own layer did.
  set('--dsw-menu-surface-fill', get('bg-overlay'))
  // Primary buttons (send, confirm): accent in dark palettes, ink in light ones, as Endfield does.
  set(`${A}button-info-fill`, dark ? c.accent : label)
  // Turn status ("Deep diving…") and the HARNESS chip letters.
  set(`${A}label-deep-diving`, accentText)
  set(`${A}label-deep-diving-shimmer`, ensureContrast(mix(c.accent, c.foreground, 0.5), base, 4.5, c.foreground))
  set(`${A}label-primary-inverted`, onAccent)
  return out
}

/**
 * Colours on Stock: Endfield exactly as dsh-theme-endfield painted it (its measured token values), plus the `--edge-*`
 * variables the stylesheet reads, derived from Endfield's own palette.
 */
export function endfieldOwnLayer(mode: 'light' | 'dark'): Layer {
  const out: Layer = {}
  for (const [name, value] of Object.entries(endfieldLookLayer(endfieldPalette(mode), { semanticColors: 'dsh' }))) {
    if (name.startsWith('--edge-')) out[name] = value
  }
  const own = mode === 'dark' ? ENDFIELD_OWN_DARK : ENDFIELD_OWN_LIGHT
  for (const [name, value] of Object.entries(own)) out[name] = { light: value, dark: value }
  // Endfield derives these two from its own surfaces, not from the palette maths.
  for (const [edge, token] of [['--edge-line', '--dsw-alias-border-l1'], ['--edge-soft', '--dsw-alias-bg-layer-2']] as const) {
    const value = own[token]
    if (value !== undefined) out[edge] = { light: value, dark: value }
  }
  return out
}

/** Merge the look over a base layer (look wins per token). */
export function withEndfieldLook(base: Layer, palette: OmarchyPalette, options: TokenOptions): Layer {
  return { ...base, ...endfieldLookLayer(palette, options) }
}

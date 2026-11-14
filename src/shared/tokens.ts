// Omarchy palette -> DSH alias token layer.
// Only `--dsw-alias-*` / `--dsw-specific-*` / `--shiki-token-*` names that exist in tools/dsw-defined.txt are produced;
// `--dsw-static-*` scales are never touched, so a DSH release that renames statics cannot corrupt the layer.
import { alpha, contrast, ensureContrast, mix, onColor } from './color.ts'
import type { Mode, OmarchyPalette } from './omarchy.ts'

export interface TokenOptions {
  /** `dsh` keeps DSH's own error/warn/success reds/ambers/greens (default); `omarchy` uses the palette's red/yellow/green. */
  semanticColors: 'dsh' | 'omarchy'
}

export const DEFAULT_TOKEN_OPTIONS: TokenOptions = { semanticColors: 'dsh' }

/** Plain `{ token: value }` map for one palette; both light and dark layer values are identical (the palette is one mode). */
export type FlatTokens = Record<string, string>

const A = '--dsw-alias-'

export function paletteTokens(palette: OmarchyPalette, options: TokenOptions = DEFAULT_TOKEN_OPTIONS): FlatTokens {
  const { colors: c, mode } = palette
  const dark = mode === 'dark'
  const t: FlatTokens = {}
  const set = (name: string, value: string): void => { t[name] = value }

  // Surfaces. Dark Omarchy themes lift layers with lighter_background; light themes use foreground tints
  // because `lighter_background` is *darker* than `background` in light palettes.
  const base = c.background
  const layer1 = dark ? c.lighter_background : base
  const layer2 = dark ? mix(c.lighter_background, c.selection, 0.5) : base
  const layer3 = dark ? c.selection : mix(base, c.foreground, 0.04)
  const overlay = dark ? mix(c.selection, c.muted, 0.5) : mix(base, c.foreground, 0.1)
  set(`${A}bg-base`, base)
  set(`${A}bg-layer-1`, layer1)
  set(`${A}bg-layer-2`, layer2)
  set(`${A}bg-layer-3`, layer3)
  set(`${A}bg-module-platform`, layer3)
  set(`${A}bg-overlay`, overlay)
  set('--dsw-specific-sidebar-fill', c.dark_background)
  set('--dsw-specific-input-major', dark ? layer2 : layer1)
  set(`${A}settings-card-fill`, dark ? layer2 : mix(base, c.foreground, 0.03))
  set('--dsw-specific-bubble', mix(base, c.accent, 0.12))
  set(`${A}card-fill`, layer2)
  set(`${A}card-fill-hover`, layer3)
  set(`${A}markdown-code-block`, c.dark_background)
  set(`${A}markdown-code-block-banner`, layer2)
  set(`${A}markdown-code-segment-selected`, c.selection)
  set(`${A}markdown-code-segment-unselected`, layer2)
  set(`${A}markdown-inline-code`, layer2)
  set(`${A}tooltip-bg`, dark ? c.selection : c.foreground)
  set(`${A}tooltip-label`, dark ? c.foreground : base)

  // Borders and interaction states are foreground alphas.
  const edge = dark ? [0.06, 0.12, 0.16, 0.2] : [0.04, 0.1, 0.12, 0.16]
  set(`${A}border-l1`, alpha(c.foreground, edge[0]!))
  set(`${A}border-l2`, alpha(c.foreground, edge[1]!))
  set(`${A}border-l2-darkmode-thin`, alpha(c.foreground, edge[0]!))
  set(`${A}border-l3`, alpha(c.foreground, edge[2]!))
  set(`${A}border-l4`, alpha(c.foreground, edge[3]!))
  set(`${A}settings-card-stroke`, alpha(c.foreground, edge[3]!))
  set(`${A}border-selected`, c.accent)
  set(`${A}interactive-bg-hover`, alpha(c.foreground, dark ? 0.08 : 0.06))
  set(`${A}interactive-bg-active`, alpha(c.foreground, dark ? 0.14 : 0.1))

  // Text, with legibility guards (Omarchy palettes occasionally ship low-contrast muted tones).
  const labelPrimary = ensureContrast(c.foreground, base, 4.5, c.bright_foreground)
  const labelSecondary = ensureContrast(c.light_foreground, base, 4, labelPrimary)
  const labelTertiary = ensureContrast(mix(c.light_foreground, c.dark_foreground, 0.5), base, 3, labelSecondary)
  set(`${A}label-primary`, labelPrimary)
  set(`${A}label-secondary`, labelSecondary)
  set(`${A}label-tertiary`, labelTertiary)
  set(`${A}label-caption`, labelTertiary)
  set(`${A}label-dimmed`, ensureContrast(c.dark_foreground, base, 2, labelTertiary))
  const ink = onColor(c.accent)
  set(`${A}label-primary-foreground`, ink)
  set(`${A}label-on-color`, ink)
  set(`${A}label-primary-inverted`, onColor(c.foreground))

  // Accent: focus ring (via state-business-primary), links, primary buttons. brand-primary stays DSH's.
  const accentText = ensureContrast(c.accent, base, 3, c.foreground)
  set(`${A}state-business-primary`, accentText)
  set(`${A}brand-primary-new-colorprimary-new-color`, c.accent)
  set(`${A}button-info-fill`, c.accent)
  set(`${A}button-info-hover`, mix(c.accent, c.foreground, 0.15))
  set(`${A}button-primary-fill`, c.accent)
  set(`${A}button-primary-hover`, mix(c.accent, c.foreground, 0.15))
  set(`${A}link`, ensureContrast(c.blue, base, 3, c.foreground))
  set(`${A}bg-document-selection`, alpha(c.accent, 0.4))

  // Status colours.
  if (options.semanticColors === 'omarchy') {
    set(`${A}state-error-primary`, c.red)
    set(`${A}state-warn-primary`, c.yellow)
    set(`${A}state-success-primary`, c.green)
    set(`${A}code-diff-added`, alpha(c.green, 0.14))
    set(`${A}code-diff-deleted`, alpha(c.red, 0.14))
  }
  set(`${A}state-done-primary`, c.magenta)
  set(`${A}state-idle-primary`, c.dark_foreground)

  set(`${A}scrollbar-bg-l1`, c.muted)
  set(`${A}scrollbar-bg-l2`, c.muted)
  set(`${A}scrollbar-hover-l1`, c.dark_foreground)
  set(`${A}scrollbar-hover-l2`, c.dark_foreground)

  // Syntax highlighting.
  set('--shiki-token-keyword', c.magenta)
  set('--shiki-token-string', c.green)
  set('--shiki-token-string-expression', c.green)
  set('--shiki-token-constant', c.cyan)
  set('--shiki-token-function', c.blue)
  set('--shiki-token-parameter', c.orange)
  set('--shiki-token-comment', c.dark_foreground)
  set('--shiki-token-punctuation', c.light_foreground)
  set('--shiki-token-link', c.blue)
  return t
}

/** Wrap a flat map into the `{ light, dark }` pairs `ctx.theme.overrideTokens` requires. */
export function toLayer(tokens: FlatTokens): Record<string, { light: string; dark: string }> {
  const out: Record<string, { light: string; dark: string }> = {}
  for (const [name, value] of Object.entries(tokens)) out[name] = { light: value, dark: value }
  return out
}

export function shellThemeId(mode: Mode): 'omarchy-dark' | 'omarchy-light' {
  return mode === 'light' ? 'omarchy-light' : 'omarchy-dark'
}

/** Lowest text/background contrast across the primary text tiers (test and diagnostics helper). */
export function worstTextContrast(tokens: FlatTokens): number {
  const bg = tokens[`${A}bg-base`]
  if (bg === undefined) return 0
  return ['label-primary', 'label-secondary', 'label-tertiary'].reduce((min, k) => {
    const v = tokens[`${A}${k}`]
    return v === undefined ? min : Math.min(min, contrast(v, bg))
  }, 21)
}

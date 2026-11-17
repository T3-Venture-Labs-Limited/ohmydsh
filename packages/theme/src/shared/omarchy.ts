// Parse an Omarchy `colors.toml` into a fully resolved palette. Mirrors `omarchy-theme-color`
// (legacy short names, ANSI aliases, derived shades, mode detection) so the page and Omarchy agree.
import { isHex, luminance, mix } from './color.ts'

export type Mode = 'light' | 'dark'

/** Every key a resolved palette carries; all values are `#rrggbb` (mode aside). */
export const PALETTE_KEYS = [
  'background', 'dark_background', 'darker_background', 'lighter_background',
  'foreground', 'dark_foreground', 'light_foreground', 'bright_foreground',
  'accent', 'selection', 'muted',
  'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown',
] as const
export type PaletteKey = (typeof PALETTE_KEYS)[number]
export type Colors = Record<PaletteKey, string>

export interface OmarchyPalette {
  mode: Mode
  colors: Colors
}

const SHORT: Record<string, string> = {
  background: 'bg', dark_background: 'dark_bg', darker_background: 'darker_bg', lighter_background: 'lighter_bg',
  foreground: 'fg', dark_foreground: 'dark_fg', light_foreground: 'light_fg', bright_foreground: 'bright_fg',
}
const ANSI: Record<string, string> = {
  red: 'color1', green: 'color2', yellow: 'color3', blue: 'color4', magenta: 'color5', cyan: 'color6',
}

/** Flat `key = "value"` parser (the whole of what colours.toml uses). Invalid colours are skipped, as Omarchy does. */
export function parseColorsToml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim().replace(/["']/g, '')
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    const quoted = /^(["'])(.*?)\1/.exec(value)
    value = quoted !== null ? (quoted[2] ?? '') : (value.split('#')[0] ?? '').trim()
    out[key] = value
  }
  return out
}

/** Resolve a parsed colours table to a full palette, or `undefined` when it has no usable background/foreground. */
export function resolvePalette(raw: Record<string, string>, lightModeFile = false): OmarchyPalette | undefined {
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = raw[k]
      if (isHex(v)) return v
    }
    return undefined
  }
  const pick = (key: string, ...more: string[]): string | undefined => get(key, SHORT[key] ?? key, ...more)

  const background = pick('background', 'color0')
  const foreground = pick('foreground', 'color7')
  if (background === undefined || foreground === undefined) return undefined

  const red = get('red', ANSI['red']!) ?? '#cc3333' // artwork:ok
  const yellow = get('yellow', ANSI['yellow']!) ?? '#ccaa33' // artwork:ok
  const green = get('green', ANSI['green']!) ?? '#33aa55' // artwork:ok
  const blue = get('blue', ANSI['blue']!) ?? '#3377cc' // artwork:ok
  const magenta = get('magenta', 'purple', ANSI['magenta']!) ?? '#aa55aa' // artwork:ok
  const cyan = get('cyan', ANSI['cyan']!) ?? '#33aaaa' // artwork:ok
  const orange = get('orange') ?? yellow
  const darkFg = pick('dark_foreground', 'color8') ?? foreground
  const lightFg = pick('light_foreground') ?? foreground

  const colors: Colors = {
    background,
    foreground,
    dark_background: pick('dark_background') ?? mix(background, '#000000', 0.25), // artwork:ok
    darker_background: pick('darker_background') ?? mix(background, '#000000', 0.5), // artwork:ok
    lighter_background: pick('lighter_background', 'color0') ?? background,
    dark_foreground: darkFg,
    light_foreground: lightFg,
    bright_foreground: pick('bright_foreground', 'color15') ?? foreground,
    muted: get('muted', 'color8') ?? darkFg,
    selection: get('selection', 'selection_background', 'color8') ?? background,
    accent: get('accent') ?? blue,
    red, yellow, orange, green, cyan, blue, magenta,
    brown: get('brown') ?? mix(orange, '#000000', 0.5), // artwork:ok
  }

  const declared = (raw['mode'] ?? raw['theme_type'] ?? '').toLowerCase()
  let mode: Mode
  if (declared === 'light' || declared === 'dark') mode = declared
  else if (lightModeFile) mode = 'light'
  else {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16))
    mode = (r ?? 0) + (g ?? 0) + (b ?? 0) > 382 ? 'light' : 'dark'
  }
  return { mode, colors }
}

/** Mode from luminance alone, for palettes that carry no declaration. */
export function modeOf(background: string): Mode {
  return luminance(background) > 0.35 ? 'light' : 'dark'
}

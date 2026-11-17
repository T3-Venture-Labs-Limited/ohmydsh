// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, ensureContrast, mix } from '../src/shared/color.ts'
import { parseColorsToml, resolvePalette } from '../src/shared/omarchy.ts'
import { paletteTokens, toLayer, worstTextContrast } from '../src/shared/tokens.ts'
import { PALETTES } from '../src/artwork/palettes.ts'

const defined = new Set(readFileSync(resolve(import.meta.dirname, '../tools/dsw-defined.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('--')))

const MATTE = `mode = "dark"
accent = "#e68e0d"
selection = "#2a2a2a"
muted = "#333333"
background = "#121212"
dark_background = "#0d0d0d"
darker_background = "#090909"
lighter_background = "#1e1e1e"
foreground = "#bebebe"
dark_foreground = "#555555"
light_foreground = "#8a8a8d"
bright_foreground = "#bebebe"
red = "#D35F5F"
yellow = "#b91c1c"
orange = "#c63d3d"
green = "#FFC107"
cyan = "#bebebe"
blue = "#e68e0d"
magenta = "#D35F5F"
brown = "#631e1e"
`

describe('colors.toml parsing', () => {
  it('resolves matte-black', () => {
    const p = resolvePalette(parseColorsToml(MATTE))
    expect(p?.mode).toBe('dark')
    expect(p?.colors.accent).toBe('#e68e0d')
    expect(p?.colors.background).toBe('#121212')
  })
  it('detects light mode by declaration, light.mode file and luminance', () => {
    expect(resolvePalette(parseColorsToml('mode = "light"\nbackground="#101010"\nforeground="#ffffff"'))?.mode).toBe('light')
    expect(resolvePalette(parseColorsToml('background="#101010"\nforeground="#ffffff"'), true)?.mode).toBe('light')
    expect(resolvePalette(parseColorsToml('background="#fafafa"\nforeground="#202020"'))?.mode).toBe('light')
    expect(resolvePalette(parseColorsToml('background="#202020"\nforeground="#fafafa"'))?.mode).toBe('dark')
  })
  it('skips invalid colours, accepts legacy short names and ANSI aliases, derives missing shades', () => {
    const p = resolvePalette(parseColorsToml('bg = "#101010"\nfg = "#eeeeee"\naccent = "nope"\ncolor1 = "#ff0000"\ncolor4 = "#0000ff"'))
    expect(p?.colors.accent).toBe('#0000ff')
    expect(p?.colors.red).toBe('#ff0000')
    expect(p?.colors.dark_background).toBe(mix('#101010', '#000000', 0.25))
  })
  it('rejects a palette with no background', () => {
    expect(resolvePalette(parseColorsToml('foreground = "#fff"'))).toBeUndefined()
  })
})

describe('token generator', () => {
  const matte = resolvePalette(parseColorsToml(MATTE))!
  it('only emits tokens that exist in the installed theme sheets', () => {
    const names = [...Object.keys(paletteTokens(matte)), ...Object.keys(paletteTokens(matte, { semanticColors: 'omarchy' }))]
    // dsw-defined.txt lists --dsw-* only; shiki names are checked against shiki.css separately
    expect(names.filter((n) => n.startsWith('--dsw-') && !defined.has(n))).toEqual([])
    expect(names.filter((n) => !n.startsWith('--dsw-') && !/^--shiki-token-(keyword|string|string-expression|constant|function|parameter|comment|punctuation|link)$/.test(n))).toEqual([])
  })
  it('maps the tier-1 tokens from matte-black', () => {
    const t = paletteTokens(matte)
    expect(t['--dsw-alias-bg-base']).toBe('#121212')
    expect(t['--dsw-alias-bg-layer-1']).toBe('#1e1e1e')
    expect(t['--dsw-specific-sidebar-fill']).toBe('#0d0d0d')
    expect(t['--dsw-alias-button-primary-fill']).toBe('#e68e0d')
    expect(t['--dsw-alias-label-primary']).toBe('#bebebe')
  })
  it('keeps DSH status colours by default and uses Omarchy ones on request', () => {
    expect(paletteTokens(matte)['--dsw-alias-state-error-primary']).toBeUndefined()
    expect(paletteTokens(matte, { semanticColors: 'omarchy' })['--dsw-alias-state-error-primary']).toBe('#D35F5F')
  })
  it('produces identical light/dark pairs and about 45+ aliases', () => {
    const layer = toLayer(paletteTokens(matte))
    expect(Object.keys(layer).length).toBeGreaterThanOrEqual(45)
    for (const v of Object.values(layer)) expect(v.light).toBe(v.dark)
  })
  it('light palettes lift surfaces from foreground, not lighter_background', () => {
    const latte = resolvePalette(parseColorsToml('mode="light"\nbackground="#eff1f5"\nlighter_background="#dce0e8"\nforeground="#4c4f69"'))!
    expect(paletteTokens(latte)['--dsw-alias-bg-layer-1']).toBe('#eff1f5')
  })
  it('every bundled palette keeps text legible', () => {
    for (const p of PALETTES) {
      const tokens = paletteTokens({ mode: p.mode, colors: p.colors })
      expect(worstTextContrast(tokens), p.id).toBeGreaterThanOrEqual(3)
      expect(contrast(tokens['--dsw-alias-label-primary']!, tokens['--dsw-alias-bg-base']!), p.id).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('ensureContrast nudges toward the target', () => {
    expect(contrast(ensureContrast('#777777', '#808080', 4.5, '#000000'), '#808080')).toBeGreaterThanOrEqual(4.5)
  })
})

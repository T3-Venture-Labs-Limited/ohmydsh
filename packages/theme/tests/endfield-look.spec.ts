// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ThemeController, LOOK_URL } from '../src/client/controller.ts'
import type { ControllerDeps } from '../src/client/controller.ts'
import { endfieldLookCss } from '../src/client/endfield-look-css.ts'
import { endfieldLookLayer, endfieldOwnLayer, endfieldPalette } from '../src/shared/endfield-look.ts'
import { endfieldLayer } from '../src/shared/endfield.ts'
import { contrast, mix } from '../src/shared/color.ts'
import { paletteById } from '../src/artwork/palettes.ts'
import type { OmarchyPalette } from '../src/shared/omarchy.ts'

const defined = new Set(readFileSync(join(__dirname, '..', 'tools', 'dsw-defined.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))

/** Every selector of a stylesheet (comments removed, @media unwrapped), split on top-level commas. */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const m of text.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const prelude = m[1]!.trim()
    if (prelude.startsWith('@')) continue
    let depth = 0; let cur = ''
    for (const ch of prelude) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = '' } else cur += ch
    }
    if (cur.trim() !== '') out.push(cur.trim())
  }
  return out
}

describe('Endfield look stylesheet: cost rules', () => {
  for (const mode of ['dark', 'light'] as const) {
    const css = endfieldLookCss(mode)
    const sels = selectors(css)
    it(`${mode}: has rules and stays small`, () => {
      expect(sels.length).toBeGreaterThan(40)
      expect(css.length).toBeLessThan(16_000) // dsh-theme-endfield ships ~166 KB
    })
    it(`${mode}: no :has(), no body prefixes, no scheme attribute`, () => {
      for (const s of sels) {
        expect(s, s).not.toMatch(/:has\(/)
        expect(s, s).not.toMatch(/^body\b|\sbody\b/)
        expect(s, s).not.toMatch(/data-ds-dark-theme/)
      }
    })
    it(`${mode}: no descendant or child universal selectors (X *, X > *)`, () => {
      for (const s of sels) expect(s, s).not.toMatch(/[\s>+~]\*/)
    })
    it(`${mode}: every --dsw token it reads or writes exists`, () => {
      for (const name of css.match(/--dsw-[a-z0-9-]+/g) ?? []) expect(defined.has(name), name).toBe(true)
    })
  }
})

const palettes: [string, OmarchyPalette][] = [
  ['omarchy-like dark', { mode: 'dark', colors: { ...paletteById('catppuccin-mocha')!.colors, background: '#1b1b1b', accent: '#e06c75' } }],
  ['endfield dark', endfieldPalette('dark')],
  ['endfield light', endfieldPalette('light')],
  ['catppuccin latte', { mode: 'light', colors: paletteById('catppuccin-latte')!.colors }],
]

describe('Endfield look token layer', () => {
  it.each(palettes)('%s: the tokens it adds are known --dsw tokens, both slots equal', (_, palette) => {
    const layer = endfieldLookLayer(palette, { semanticColors: 'dsh' })
    const compat = endfieldLayer(palette, { semanticColors: 'dsh' }) // shipped compat layer; may carry endfield-only names
    for (const [name, v] of Object.entries(layer)) {
      if (name in compat) continue
      if (name.startsWith('--dsw-')) expect(defined.has(name), name).toBe(true)
      expect(v.light, name).toBe(v.dark)
    }
  })
  it.each(palettes)('%s: text on the accent and on filled rows stays readable', (_, palette) => {
    const layer = endfieldLookLayer(palette, { semanticColors: 'dsh' })
    const v = (n: string): string => layer[n]!.dark
    expect(contrast(v('--edge-on-accent'), palette.colors.accent)).toBeGreaterThanOrEqual(4.5)
    // Light palettes fill rows with a 22% accent wash over the background.
    const fill = palette.mode === 'dark' ? v('--edge-row-fill') : mix(palette.colors.background, palette.colors.accent, 0.22)
    expect(contrast(v('--edge-row-ink'), fill)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('Endfield own tokens (colours on Stock)', () => {
  it.each(['light', 'dark'] as const)('%s: only known --dsw tokens and the stylesheet variables, readable fills', (mode) => {
    const layer = endfieldOwnLayer(mode)
    for (const name of Object.keys(layer)) expect(name.startsWith('--edge-') || defined.has(name), name).toBe(true)
    expect(layer['--dsw-alias-bg-base']?.dark).toBe(mode === 'dark' ? '#101110' : '#e8e8e2')
    expect(contrast(layer['--edge-on-accent']!.dark, layer['--edge-accent']!.dark)).toBeGreaterThanOrEqual(4.5)
  })
})

// ---- controller ----
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function rig(o: { hostDefault?: 'stock' | 'endfield'; stored?: Record<string, string>; endfieldPresent?: boolean; hostname?: string } = {}) {
  let scheme: 'light' | 'dark' = 'dark'
  const listeners = new Set<(s: unknown) => void>()
  const layers = new Map<string, Record<string, { light: string; dark: string }>>()
  const emit = () => { for (const l of [...listeners]) l({ preference: 'system', active: { colorScheme: scheme } }) }
  const storage = new Map<string, string>(Object.entries(o.stored ?? {}))
  const css: (string | undefined)[] = []
  const fetchImpl = (async (url: string) => {
    if (url === LOOK_URL) return { ok: true, text: async () => JSON.stringify({ look: o.hostDefault ?? 'stock' }) }
    return { ok: false, text: async () => '' }
  }) as unknown as typeof fetch
  const deps = {
    theme: {
      getTheme: () => ({ preference: 'system', active: { colorScheme: scheme } }),
      overrideTokens: (s: string, t: Record<string, { light: string; dark: string }>) => { layers.set(s, t); emit(); return () => { layers.delete(s); emit() } },
    },
    onThemeChange: (l: never) => { listeners.add(l); return () => { listeners.delete(l) } },
    storage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } },
    hostname: o.hostname ?? '100.64.0.1',
    fetchImpl,
    look: { apply: (c: string | undefined) => { css.push(c) } },
    ...(o.endfieldPresent === undefined ? {} : { endfield: { present: () => o.endfieldPresent, subscribe: () => () => {}, bridge: () => {} } }),
  } as unknown as ControllerDeps
  const c = new ThemeController(deps)
  return { c, layers, css, storage, setScheme: (m: 'light' | 'dark') => { scheme = m; emit() }, mounted: () => css.at(-1) !== undefined }
}

describe('Endfield look in the controller', () => {
  it('is off by default and draws nothing with Stock colours', async () => {
    const r = rig(); r.c.start(); await tick()
    expect(r.c.getSnapshot().look).toBe('stock')
    expect(r.layers.size).toBe(0)
    expect(r.mounted()).toBe(false)
  })
  it('the profile default turns it on: Stock colours get Endfield\u2019s own palette, and the default is cached', async () => {
    const r = rig({ hostDefault: 'endfield' }); r.c.start(); await tick(); await tick()
    expect(r.c.getSnapshot().look).toBe('endfield')
    expect(r.mounted()).toBe(true)
    expect(r.layers.get('dsh-theme')?.['--edge-accent']?.dark).toBe('#fff500')
    expect(r.storage.get('dsh-theme.lookDefault')).toBe('endfield')
  })
  it('follows Appearance with Stock colours (Endfield light/dark palette)', async () => {
    const r = rig({ hostDefault: 'endfield' }); r.c.start(); await tick(); await tick()
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.dark).toBe('#101110')
    r.setScheme('light')
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.light).toBe('#e8e8e2')
  })
  it('a cached default applies before the Host answers', () => {
    const r = rig({ stored: { 'dsh-theme.lookDefault': 'endfield' } })
    r.c.start()
    expect(r.mounted()).toBe(true)
  })
  it('a browser choice wins over the profile default, both ways, and Profile default restores it', async () => {
    const off = rig({ hostDefault: 'endfield', stored: { 'dsh-theme.look': 'stock' } }); off.c.start(); await tick(); await tick()
    expect(off.c.getSnapshot().look).toBe('stock')
    expect(off.mounted()).toBe(false)
    off.c.setLook('default')
    expect(off.c.getSnapshot().look).toBe('endfield')
    expect(off.mounted()).toBe(true)
    const on = rig({ hostDefault: 'stock' }); on.c.start(); await tick()
    on.c.setLook('endfield')
    expect(on.mounted()).toBe(true)
    expect(on.storage.get('dsh-theme.look')).toBe('endfield')
  })
  it('uses the followed palette when colours are not Stock', async () => {
    const r = rig({ hostDefault: 'endfield', stored: { 'dsh-theme.choice': 'catppuccin-mocha' } }); r.c.start(); await tick(); await tick()
    expect(r.layers.get('dsh-theme')?.['--edge-accent']?.dark).toBe(paletteById('catppuccin-mocha')!.colors.accent)
    expect(r.layers.get('dsh-theme')?.['--edge-row-fill']).toBeDefined()
    expect(r.mounted()).toBe(true)
  })
  it('stays off while the real dsh-theme-endfield plugin is on the page', async () => {
    const r = rig({ hostDefault: 'endfield', endfieldPresent: true, stored: { 'dsh-theme.choice': 'catppuccin-mocha' } }); r.c.start(); await tick(); await tick()
    expect(r.mounted()).toBe(false)
    expect(r.layers.get('dsh-theme')?.['--edge-row-fill']).toBeUndefined()
  })
  it('disposing removes the stylesheet and the layer', async () => {
    const r = rig({ hostDefault: 'endfield' }); const stop = r.c.start(); await tick(); await tick()
    stop()
    expect(r.mounted()).toBe(false)
    expect(r.layers.size).toBe(0)
  })
})

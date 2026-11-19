// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ThemeController, MAX_REAPPLY } from '../src/client/controller.ts'
import type { ControllerDeps } from '../src/client/controller.ts'
import { endfieldLayer } from '../src/shared/endfield.ts'
import { inkRules } from '../src/client/endfield-dom.ts'
import { paletteById } from '../src/artwork/palettes.ts'

type Mode = 'light' | 'dark'
type Layer = Record<string, { light: string; dark: string }>

/** A tiny ThemeRuntime: layers by source in registration order, later wins per token, theme/change on every change. */
function runtime(scheme: Mode = 'dark') {
  const layers = new Map<string, { seq: number; tokens: Layer }>()
  let seq = 0
  const listeners = new Set<(s: never) => void>()
  const tokens = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const l of [...layers.values()].sort((a, b) => a.seq - b.seq)) for (const [k, v] of Object.entries(l.tokens)) out[k] = v[scheme]
    return out
  }
  const snap = () => ({ preference: 'system', active: { colorScheme: scheme, tokens: tokens() } })
  const emit = (): void => { for (const l of [...listeners]) l(snap() as never) }
  const overrideTokens = (source: string, t: Layer) => {
    const layer = { seq: seq++, tokens: t }
    layers.set(source, layer)
    emit()
    return () => { if (layers.get(source) === layer) { layers.delete(source); emit() } }
  }
  return { layers, tokens, overrideTokens, getTheme: snap, onThemeChange: (l: never) => { listeners.add(l); return () => { listeners.delete(l) } } }
}

function endfieldFace(initial: boolean) {
  let present = initial
  const subs = new Set<() => void>()
  const bridge = vi.fn()
  return { face: { present: () => present, subscribe: (l: () => void) => { subs.add(l); return () => { subs.delete(l) } }, bridge }, set(v: boolean) { present = v; for (const s of [...subs]) s() }, bridge }
}
const registerEndfield = (rt: ReturnType<typeof runtime>) => rt.overrideTokens('edge-intelligence-theme', {
  '--dsw-alias-bg-base': { light: '#e8e8e2', dark: '#101110' },
  '--dsw-alias-brand-primary': { light: '#101110', dark: 'var(--edge-accent)' },
})

function rig(withFace: ReturnType<typeof endfieldFace> | undefined, scheme: Mode = 'dark') {
  const rt = runtime(scheme)
  const deps = {
    theme: rt, onThemeChange: rt.onThemeChange, storage: { getItem: (k: string) => (k === 'dsh-theme.choice' ? 'dracula' : null), setItem() {} },
    hostname: '127.0.0.1', endfield: withFace?.face,
  } as unknown as ControllerDeps
  const c = new ThemeController(deps)
  return { rt, c }
}

describe('endfieldLayer', () => {
  const palette = paletteById('dracula')!
  it('maps endfield variables and its colour tokens to the palette, in both slots', () => {
    const layer = endfieldLayer({ mode: palette.mode, colors: palette.colors }, { semanticColors: 'dsh' })
    expect(layer['--edge-accent']).toEqual({ light: palette.colors.accent, dark: palette.colors.accent })
    expect(layer['--edge-accent-rgb']?.dark).toMatch(/^\d+, \d+, \d+$/)
    expect(layer['--dsw-alias-brand-primary']?.dark).toBe(layer['--dsw-static-deepseek-450']?.dark)
    expect(layer['--edge-on-accent']?.dark).toMatch(/^#[0-9a-f]{6}$/)
    // Palette tokens are identical in both slots; only the DSH status references differ per scheme (red-600 light / red-400 dark).
    for (const [name, modes] of Object.entries(layer)) if (!name.includes('state-error') && !name.includes('label-error')) expect(modes.light).toBe(modes.dark)
  })
  it('keeps DSH status colours by default and the palette ones when asked', () => {
    const p = { mode: palette.mode, colors: palette.colors }
    expect(endfieldLayer(p, { semanticColors: 'dsh' })['--dsw-alias-state-error-primary']?.dark).toContain('--dsw-static-red-400')
    expect(endfieldLayer(p, { semanticColors: 'omarchy' })['--dsw-alias-state-error-primary']).toBeUndefined()
  })
})

describe('inkRules', () => {
  const rule = (selectorText: string, props: Record<string, [string, string]>) => ({
    selectorText, style: { getPropertyValue: (n: string) => props[n]?.[0] ?? '', getPropertyPriority: (n: string) => props[n]?.[1] ?? '' },
  })
  it('re-points endfield ink-on-accent text at the on-accent token, one type selector stronger', () => {
    const css = inkRules([
      rule("[class$='_newSession']", { color: ['rgb(0, 0, 0)', 'important'] }),
      rule("[class$='_sidebarCol'] [class*='_sessionRow']:hover *", { color: ['#000', 'important'] }),
      rule('.unrelated', { color: ['red', 'important'] }),
      rule('[data-endfield-balance]', { color: ['#000', 'important'] }),
      rule("body[data-ds-dark-theme] [role='dialog'][class*='_confirmation']", { color: ['#101110', ''] }),
    ])
    expect(css).toContain("html :is([class$='_newSession']) { color: var(--edge-on-accent) !important }")
    expect(css).toContain('html body:not([data-ds-dark-theme]) :is([class$=\'_sidebarCol\'] [class*=\'_sessionRow\']:hover *) { color: var(--dsw-alias-label-primary) !important }')
    expect(css).not.toContain('unrelated')
    expect(css).not.toContain('endfield-balance')
    expect(css).not.toContain('confirmation')
  })
})

describe('controller with dsh-theme-endfield', () => {
  it('without endfield nothing changes: the layer is exactly the stock token layer', () => {
    const r = rig(undefined)
    r.c.start()
    const layer = r.rt.layers.get('dsh-theme')!.tokens
    expect(layer['--edge-accent']).toBeUndefined()
    expect(layer['--dsw-static-deepseek-450']).toBeUndefined()
    expect(r.c.getSnapshot().endfield).toBe(false)
  })
  it('a page without endfield (face reports absent) also carries no extras and no bridge', () => {
    const ef = endfieldFace(false)
    const r = rig(ef)
    r.c.start()
    expect(r.rt.layers.get('dsh-theme')!.tokens['--edge-accent']).toBeUndefined()
    expect(ef.bridge).toHaveBeenLastCalledWith(false)
  })
  it('wins tokens back when endfield registered after us, and does not loop', () => {
    const ef = endfieldFace(true)
    const r = rig(ef)
    r.c.start()
    registerEndfield(r.rt)               // endfield registers last: its bg-base now wins
    const t = r.rt.tokens()
    expect(t['--dsw-alias-bg-base']).toBe('#282a36')   // dracula background: ours was re-registered on top
    expect(t['--dsw-alias-brand-primary']).not.toContain('var(--edge-accent)')
    expect(t['--edge-accent']).toBeDefined()
    expect(ef.bridge).toHaveBeenLastCalledWith(true)
  })
  it('a peer that insists on winning cannot start an endless loop: our re-registrations are rate-limited', () => {
    const ef = endfieldFace(true)
    const r = rig(ef)
    let ours = 0
    const inner = r.rt.overrideTokens
    r.rt.overrideTokens = (source: string, t: Layer) => { if (source === 'dsh-theme') ours++; return inner(source, t) }
    // Stubborn peer: whenever our layer is on top of it, it registers again (bounded here only to keep a bug from hanging the test).
    let peer = 0
    r.rt.onThemeChange((() => { if (r.rt.tokens()['--dsw-alias-bg-base'] !== '#101110' && peer++ < 500) registerEndfield(r.rt) }) as never)
    r.c.start()
    registerEndfield(r.rt)
    expect(ours).toBeLessThanOrEqual(1 + MAX_REAPPLY)
    expect(peer).toBeLessThan(500)
  })
  it('engages when endfield appears later and reverts to the plain layer when it goes away', () => {
    const ef = endfieldFace(false)
    const r = rig(ef)
    r.c.start()
    ef.set(true)
    expect(r.c.getSnapshot().endfield).toBe(true)
    expect(r.rt.layers.get('dsh-theme')!.tokens['--edge-accent']).toBeDefined()
    ef.set(false)
    expect(r.c.getSnapshot().endfield).toBe(false)
    expect(r.rt.layers.get('dsh-theme')!.tokens['--edge-accent']).toBeUndefined()
    expect(ef.bridge).toHaveBeenLastCalledWith(false)
  })
  it('dispose removes the layer and the bridge', () => {
    const ef = endfieldFace(true)
    const r = rig(ef)
    const stop = r.c.start()
    stop()
    expect(r.rt.layers.size).toBe(0)
    expect(ef.bridge).toHaveBeenLastCalledWith(false)
  })
})

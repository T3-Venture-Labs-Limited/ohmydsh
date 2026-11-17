// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ThemeController } from '../src/client/controller.ts'
import type { ControllerDeps, OmarchyWire } from '../src/client/controller.ts'
import { PALETTE_KEYS } from '../src/shared/omarchy.ts'

const colors = (bg: string, accent: string) => Object.fromEntries(PALETTE_KEYS.map((k) => [k, k === 'background' ? bg : k === 'accent' ? accent : '#777777'])) as Required<OmarchyWire>['colors']
const wire = (generation: string, mode: 'dark' | 'light', bg: string, accent: string): OmarchyWire => ({ available: true, generation, name: 'x', mode, colors: colors(bg, accent) })

/** A controllable live stream: `open` hands out generations; push() delivers one item and lets the pump run. */
class FakeStream {
  static last: FakeStream | undefined
  static opened = 0
  closed = false
  private items: unknown[] = []
  private wake: (() => void) | undefined
  constructor(public signal: AbortSignal) {
    FakeStream.last = this; FakeStream.opened++
    signal.addEventListener('abort', () => { this.closed = true; this.wake?.() }, { once: true })
  }
  static open(signal: AbortSignal): AsyncIterable<unknown> {
    const stream = new FakeStream(signal)
    return { [Symbol.asyncIterator]: async function* () {
      while (!signal.aborted) {
        if (stream.items.length > 0) { yield stream.items.shift(); continue }
        await new Promise<void>((resolve) => { stream.wake = resolve })
      }
    } }
  }
  async push(w: OmarchyWire) { this.items.push(w); this.wake?.(); await tick() }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

interface RigOpts { hostname?: string; shared?: { host: object; doc?: unknown } }
function rig(initialChoice?: string, opts: RigOpts = {}) {
  const shared = opts.shared
  const pushHost = shared?.host ?? {}
  let scheme: 'light' | 'dark' = 'light'
  const listeners = new Set<(s: { preference: string; active: { colorScheme: 'light' | 'dark' } }) => void>()
  const emit = () => { for (const l of listeners) l({ preference: 'system', active: { colorScheme: scheme } }) }
  const layers = new Map<string, Record<string, { light: string; dark: string }>>()
  const storage = new Map<string, string>(initialChoice === undefined ? [] : [['dsh-theme.choice', initialChoice]])
  const setTheme = vi.fn()
  const deps = {
    theme: {
      getTheme: () => ({ preference: 'system', active: { colorScheme: scheme } }),
      setTheme,
      register: vi.fn(),
      overrideTokens: (s: string, t: Record<string, { light: string; dark: string }>) => { layers.set(s, t); emit(); return () => { layers.delete(s); emit() } },
    },
    onThemeChange: (l: never) => { listeners.add(l); return () => { listeners.delete(l) } },
    storage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } },
    open: FakeStream.open,
    push: { host: pushHost },
    hostname: opts.hostname ?? '127.0.0.1',
    ...(shared?.doc === undefined ? {} : { doc: shared.doc as never }),
  } as unknown as ControllerDeps
  const c = new ThemeController(deps)
  return { c, layers, setTheme, register: deps.theme as unknown as { register: ReturnType<typeof vi.fn> }, storage, setScheme: (m: 'light' | 'dark') => { scheme = m; emit() } }
}

describe('ThemeController', () => {
  describe('default choice by host', () => {
    it.each(['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3', 'LOCALHOST'])('%s is this computer: follows Omarchy', (h) => {
      expect(rig(undefined, { hostname: h }).c.getSnapshot().choice).toBe('omarchy')
    })
    it.each(['100.93.77.123', 'superdao.tail1234.ts.net', '192.168.1.121', 'example.com', undefined])('%s is another device: stock', (h) => {
      const r = rig(undefined, h === undefined ? { hostname: '' } : { hostname: h })
      expect(r.c.getSnapshot().choice).toBe('stock')
    })
    it('a tailnet host with no stored choice opens no stream and applies nothing', async () => {
      FakeStream.last = undefined
      const r = rig(undefined, { hostname: '100.93.77.123' })
      r.c.start(); await tick()
      expect(FakeStream.last).toBeUndefined()
      expect(r.layers.size).toBe(0)
    })
    it('a stored choice wins over the host default, both ways', () => {
      expect(rig('dracula', { hostname: '100.93.77.123' }).c.getSnapshot().choice).toBe('dracula')
      expect(rig('omarchy', { hostname: '100.93.77.123' }).c.getSnapshot().choice).toBe('omarchy')
      expect(rig('stock', { hostname: '127.0.0.1' }).c.getSnapshot().choice).toBe('stock')
    })
    it('an unknown stored value falls back to the host default', () => {
      expect(rig('nonsense', { hostname: '127.0.0.1' }).c.getSnapshot().choice).toBe('omarchy')
      expect(rig('nonsense', { hostname: '10.0.0.5' }).c.getSnapshot().choice).toBe('stock')
    })
  })
  it('follows Omarchy through the token layer only: no setTheme, no shell themes', async () => {
    const r = rig('omarchy')
    const stop = r.c.start()
    await tick()
    expect(FakeStream.last).toBeDefined()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.dark).toBe('#121212')
    await FakeStream.last!.push(wire('2', 'light', '#eff1f5', '#1e66f5'))
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.light).toBe('#eff1f5')
    stop()
    expect(r.setTheme).not.toHaveBeenCalled()
    expect(r.register.register).not.toHaveBeenCalled()
  })
  it('fills BOTH slots with the Omarchy palette whatever the rendered scheme is', async () => {
    const r = rig('omarchy')
    r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    const layer = r.layers.get('dsh-theme')!
    expect(Object.keys(layer).length).toBeGreaterThan(30)
    for (const modes of Object.values(layer)) expect(modes.light).toBe(modes.dark)
    expect(layer['--dsw-alias-bg-base']).toEqual({ light: '#121212', dark: '#121212' })
    await FakeStream.last!.push(wire('2', 'light', '#eff1f5', '#1e66f5'))
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']).toEqual({ light: '#eff1f5', dark: '#eff1f5' })
  })
  it('ignores a repeated generation and invalid payloads', async () => {
    const r = rig('omarchy')
    r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    const layer = r.layers.get('dsh-theme')
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    expect(r.layers.get('dsh-theme')).toBe(layer)
    await FakeStream.last!.push({ available: true, generation: '3', mode: 'dark', colors: { background: 'nope' } } as never)
    expect(r.layers.size).toBe(0)
    expect(r.c.getSnapshot().status).toBe('unavailable')
  })
  it('disposing removes the layer and closes the stream, without touching Appearance', async () => {
    const r = rig('omarchy')
    const stop = r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    stop()
    expect(r.layers.size).toBe(0)
    expect(r.setTheme).not.toHaveBeenCalled()
    await tick()
    expect(FakeStream.last?.closed).toBe(true)
  })
  it('switching to Stock removes the layer', async () => {
    const r = rig('omarchy')
    r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    r.c.setChoice('stock')
    expect(r.layers.size).toBe(0)
    expect(r.setTheme).not.toHaveBeenCalled()
  })
  it('Appearance changes never pause or change following, and never trigger a write', async () => {
    const r = rig('omarchy')
    r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    const layer = r.layers.get('dsh-theme')
    r.setScheme('dark'); r.setScheme('light'); r.setScheme('dark')
    await tick()
    expect(r.c.getSnapshot().choice).toBe('omarchy')
    expect(r.layers.get('dsh-theme')).toBe(layer)
    expect(r.storage.get('dsh-theme.choice')).toBe('omarchy')
    expect(r.setTheme).not.toHaveBeenCalled()
  })
  it('tracks the rendered scheme so the page can hint when it disagrees with the palette', async () => {
    const r = rig('omarchy')
    r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    expect(r.c.getSnapshot()).toMatchObject({ scheme: 'light', applied: { mode: 'dark' } })
    r.setScheme('dark')
    expect(r.c.getSnapshot().scheme).toBe('dark')
  })
  it('setTheme is never called while switching choices and palettes', async () => {
    const r = rig('stock')
    r.c.start()
    r.c.setChoice('catppuccin-mocha'); r.c.setChoice('solarized-light'); r.c.setChoice('omarchy'); r.c.setChoice('stock')
    expect(r.setTheme).not.toHaveBeenCalled()
  })
  it('bundled palettes apply without a stream', async () => {
    FakeStream.last = undefined
    const r = rig('dracula')
    r.c.start()
    expect(FakeStream.last).toBeUndefined()
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.dark).toBe('#282a36')
    r.c.setChoice('solarized-light')
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.light).toBe('#fdf6e3')
    expect(r.setTheme).not.toHaveBeenCalled()
  })
  it('flipping the status-colour switch re-applies the layer', async () => {
    const r = rig('dracula')
    r.c.start()
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-state-error-primary']).toBeUndefined()
    r.c.setSemanticColors('omarchy')
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-state-error-primary']?.dark).toBe('#ff5555')
  })
  describe('connections', () => {
    class Doc {
      visibilityState: 'visible' | 'hidden' = 'visible'
      private hs = new Set<() => void>()
      addEventListener(_t: string, h: () => void) { this.hs.add(h) }
      removeEventListener(_t: string, h: () => void) { this.hs.delete(h) }
      set(v: 'visible' | 'hidden') { this.visibilityState = v; for (const h of this.hs) h() }
    }
    it('holds no stream while the page is hidden and reopens it when visible', async () => {
      FakeStream.opened = 0
      const doc = new Doc(); doc.set('hidden')
      const r = rig('omarchy', { shared: { host: {}, doc } })
      const stop = r.c.start()
      await tick()
      expect(FakeStream.opened).toBe(0)
      doc.set('visible')
      await tick()
      expect(FakeStream.opened).toBe(1)
      doc.set('hidden')
      await tick()
      expect(FakeStream.last?.closed).toBe(true)
      stop()
    })
    it('two mounts of the plugin on one page share a single stream', async () => {
      FakeStream.opened = 0
      const host = {}; const doc = new Doc()
      const a = rig('omarchy', { shared: { host, doc } }); const b = rig('omarchy', { shared: { host, doc } })
      const stopA = a.c.start(); const stopB = b.c.start()
      await tick()
      expect(FakeStream.opened).toBe(1)
      await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
      expect(a.layers.get('dsh-theme')).toBeDefined()
      expect(b.layers.get('dsh-theme')).toBeDefined()
      stopA(); stopB()
    })
  })
})

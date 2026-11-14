// @vitest-environment node
import { describe, expect, it } from 'vitest'
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

function rig(initialChoice?: string, user = false, shared?: { host: object; doc?: unknown }) {
  const pushHost = shared?.host ?? {}
  let preference = 'system'
  const listeners = new Set<(s: { preference: string }) => void>()
  const emit = () => { for (const l of listeners) l({ preference }) }
  const layers = new Map<string, Record<string, { light: string; dark: string }>>()
  const shells = new Set<string>()
  const storage = new Map<string, string>(initialChoice === undefined ? [] : [['dsh-theme.choice', initialChoice]])
  const persisted: string[] = []
  const deps: ControllerDeps = {
    theme: {
      getTheme: () => ({ preference }),
      setTheme: (id) => { if (id !== 'system' && !shells.has(id) && !['light', 'dark'].includes(id)) throw new Error('unregistered'); preference = id; if (['light', 'dark', 'system'].includes(id)) persisted.push(id); emit() },
      register: (d) => { shells.add(d.id); return () => { shells.delete(d.id); if (preference === d.id) { preference = 'system'; emit() } } },
      overrideTokens: (s, t) => { layers.set(s, t); emit(); return () => { layers.delete(s); emit() } },
    },
    onThemeChange: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v) } },
    open: FakeStream.open,
    push: { host: pushHost },
    ...(shared?.doc === undefined ? {} : { doc: shared.doc as never }),
    userInitiated: () => user,
  }
  const c = new ThemeController(deps)
  return { c, layers, shells, get preference() { return preference }, setPref: (p: string) => { preference = p; emit() }, persisted, storage }
}

describe('ThemeController', () => {
  it('follows Omarchy: layer + shell theme flip, light/dark never persisted', async () => {
    const r = rig('omarchy')
    const stop = r.c.start()
    await tick()
    expect(FakeStream.last).toBeDefined()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.dark).toBe('#121212')
    expect(r.preference).toBe('omarchy-dark')
    await FakeStream.last!.push(wire('2', 'light', '#eff1f5', '#1e66f5'))
    expect(r.preference).toBe('omarchy-light')
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.light).toBe('#eff1f5')
    expect(r.persisted).toEqual([])
    stop()
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
  it('disposing restores the stock look and the user preference exactly', async () => {
    const r = rig('omarchy')
    r.setPref('light')
    const stop = r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    expect(r.preference).toBe('omarchy-dark')
    stop()
    expect(r.layers.size).toBe(0)
    expect(r.shells.size).toBe(0)
    expect(r.preference).toBe('light')
    await tick()
    expect(FakeStream.last?.closed).toBe(true)
  })
  it('switching to Stock removes the layer and restores the preference', async () => {
    const r = rig('omarchy')
    r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    r.c.setChoice('stock')
    expect(r.layers.size).toBe(0)
    expect(r.preference).toBe('system')
  })
  it('a manual Appearance change pauses following and hands the look back', async () => {
    const r = rig('omarchy')
    r.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    r.setPref('light')
    expect(r.layers.size).toBe(0)
    expect(r.c.getSnapshot().paused).toBe(true)
    expect(r.c.getSnapshot().choice).toBe('stock')
    expect(r.preference).toBe('light')
    expect(r.storage.get('dsh-theme.choice')).toBe('stock')
  })
  it('re-selecting the baseline preference by hand pauses; a Host echo of it does not', async () => {
    const echo = rig('omarchy', false)
    echo.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    echo.setPref('system')
    await Promise.resolve()
    expect(echo.c.getSnapshot().paused).toBe(false)
    expect(echo.preference).toBe('omarchy-dark')
    const click = rig('omarchy', true)
    click.c.start()
    await FakeStream.last!.push(wire('1', 'dark', '#121212', '#e68e0d'))
    click.setPref('system')
    expect(click.c.getSnapshot().paused).toBe(true)
    expect(click.layers.size).toBe(0)
  })
  it('our own layer publish is never mistaken for a user change, even while the user is clicking', async () => {
    const r = rig('stock', true)
    r.setPref('dark')
    r.c.start()
    r.c.setChoice('catppuccin-mocha')
    expect(r.c.getSnapshot()).toMatchObject({ choice: 'catppuccin-mocha', paused: false })
    expect(r.layers.size).toBe(1)
    expect(r.preference).toBe('omarchy-dark')
  })
  it('bundled palettes apply without a stream', async () => {
    FakeStream.last = undefined
    const r = rig('dracula')
    r.c.start()
    expect(FakeStream.last).toBeUndefined()
    expect(r.layers.get('dsh-theme')?.['--dsw-alias-bg-base']?.dark).toBe('#282a36')
    expect(r.preference).toBe('omarchy-dark')
    r.c.setChoice('solarized-light')
    expect(r.preference).toBe('omarchy-light')
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
      const r = rig('omarchy', false, { host: {}, doc })
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
      const a = rig('omarchy', false, { host, doc }); const b = rig('omarchy', false, { host, doc })
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

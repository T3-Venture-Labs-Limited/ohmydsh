// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ThemeController, LOOK_URL } from '../src/client/controller.ts'
import type { ControllerDeps } from '../src/client/controller.ts'
import { glassCss } from '../src/client/glass-css.ts'
import { endfieldLookCss } from '../src/client/endfield-look-css.ts'
import { GLASS_TIERS } from '../src/artwork/glass-tiers.ts'
import { glassDefaultOf, resolveGlass } from '../src/shared/glass.ts'
import type { Glass } from '../src/shared/glass.ts'
import { serveLook } from '../src/host/routes.ts'
import { createLookFace } from '../src/client/look-dom.ts'

const defined = new Set(readFileSync(join(__dirname, '..', 'tools', 'dsw-defined.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))
const tiers = ['subtle', 'standard', 'strong'] as const

/** Rules of a stylesheet as [prelude, body] (inside at-rules too), comments removed. */
function rules(css: string): { at: string; selector: string; body: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: { at: string; selector: string; body: string }[] = []
  const walk = (src: string, at: string): void => {
    let i = 0
    while (i < src.length) {
      const open = src.indexOf('{', i)
      if (open < 0) break
      const prelude = src.slice(i, open).trim()
      let depth = 1; let j = open + 1
      while (j < src.length && depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++ }
      const body = src.slice(open + 1, j - 1)
      if (prelude.startsWith('@')) walk(body, prelude)
      else out.push({ at, selector: prelude, body })
      i = j
    }
  }
  walk(text, '')
  return out
}

describe('resolveGlass: auto, explicit and the look', () => {
  it('auto is standard with the Endfield look and off with the Stock look', () => {
    expect(resolveGlass('default', 'auto', true)).toBe('standard')
    expect(resolveGlass('default', 'auto', false)).toBe('off')
  })
  it('an explicit profile value wins over the look, both ways', () => {
    expect(resolveGlass('default', 'off', true)).toBe('off')
    expect(resolveGlass('default', 'strong', false)).toBe('strong')
  })
  it('the browser choice wins over the profile', () => {
    expect(resolveGlass('subtle', 'strong', false)).toBe('subtle')
    expect(resolveGlass('off', 'standard', true)).toBe('off')
  })
  it('config parsing: unknown values are auto', () => {
    expect(glassDefaultOf(undefined)).toBe('auto')
    expect(glassDefaultOf('frosted')).toBe('auto')
    expect(glassDefaultOf(3)).toBe('auto')
    for (const v of ['auto', 'off', 'subtle', 'standard', 'strong']) expect(glassDefaultOf(v)).toBe(v)
  })
})

describe('glass stylesheet', () => {
  it('ports Endfield\u2019s tier values', () => {
    expect(GLASS_TIERS.subtle).toEqual({ alpha: { light: 0.68, dark: 0.64 }, blur: 8 })
    expect(GLASS_TIERS.standard).toEqual({ alpha: { light: 0.8, dark: 0.76 }, blur: 14 })
    expect(GLASS_TIERS.strong).toEqual({ alpha: { light: 0.9, dark: 0.88 }, blur: 22 })
  })
  for (const tier of tiers) for (const mode of ['light', 'dark'] as const) for (const endfield of [false, true]) {
    const css = glassCss({ tier, mode, endfield })
    const rs = rules(css)
    const label = `${tier} ${mode} ${endfield ? 'endfield' : 'tokens'}`
    it(`${label}: fill alpha, blur, edge and sheen`, () => {
      const { alpha, blur } = GLASS_TIERS[tier]
      const a = alpha[mode]
      const common = rs.find((r) => r.at === '' && r.selector.startsWith('[data-composer-card],'))!
      const composer = rs.find((r) => r.at === '' && r.selector === '[data-composer-card]')!
      const panel = rs.find((r) => r.at === '' && r.selector === '[data-sidebar-right-panel="push"][data-sidebar-right-open]' && /background-color/.test(r.body))!
      const pc = `${Math.round(a * 1000) / 10}%`
      expect(composer.body).toContain(endfield ? `rgb(var(--edge-glass-fill) / ${a})` : `color-mix(in srgb, var(--dsw-specific-input-major) ${pc}, transparent)`)
      expect(panel.body).toContain(endfield ? `rgb(var(--edge-glass-fill) / ${a})` : `color-mix(in srgb, var(--dsw-alias-bg-layer-1) ${pc}, transparent)`)
      expect(common.body).toContain(`rgb(255 255 255 / ${mode === 'dark' ? 0.18 : 0.65})`) // edge
      expect(common.body).toContain(`rgb(255 255 255 / ${mode === 'dark' ? 0.07 : 0.35})`) // sheen
      expect(common.body).toContain(endfield ? 'var(--edge-accent)' : 'var(--dsw-alias-state-business-primary)')
      expect(css).toContain(`backdrop-filter: blur(${blur}px) saturate(1.05)`)
    })
    it(`${label}: the blur is on the open right panel only; the composer never gets a backdrop-filter`, () => {
      for (const r of rs) {
        if (r.at !== '' || !/backdrop-filter/.test(r.body)) continue
        expect(r.selector).toBe('[data-sidebar-right-panel="push"][data-sidebar-right-open]')
      }
      for (const r of rs) if (r.selector.includes('[data-composer-card]')) expect(r.body).not.toMatch(/filter/)
      expect(css.match(/blur\(\d+px\) saturate/g)).toHaveLength(2) // the panel's blur, once with the -webkit- prefix
    })
    it(`${label}: @supports fallback is nearly opaque, prefers-reduced-transparency is opaque with no blur`, () => {
      const sup = rs.filter((r) => r.at.startsWith('@supports not'))
      expect(sup).toHaveLength(2) // composer and panel
      for (const r of sup) {
        expect(r.at).toContain('backdrop-filter: blur(1px)')
        expect(r.body).toContain(endfield ? '/ 0.96)' : ' 96%, transparent)')
      }
      const reduced = rs.filter((r) => r.at === '@media (prefers-reduced-transparency: reduce)')
      expect(reduced).toHaveLength(3)
      for (const r of reduced.slice(0, 2)) expect(r.body).toContain(endfield ? 'rgb(var(--edge-glass-fill) / 1)' : ' 100%, transparent)')
      expect(reduced.some((r) => /backdrop-filter: none/.test(r.body))).toBe(true)
    })
    it(`${label}: cost rules (no :has, no body prefix, no universal descendants), known tokens, small, no literal colours but white`, () => {
      for (const r of rs) {
        for (const s of r.selector.split(',').map((x) => x.trim())) {
          expect(s, s).not.toMatch(/:has\(/)
          expect(s, s).not.toMatch(/^body\b|\sbody\b/)
          expect(s, s).not.toMatch(/[\s>+~]\*/)
        }
      }
      for (const name of css.match(/--dsw-[a-z0-9-]+/g) ?? []) expect(defined.has(name), name).toBe(true)
      expect(css.length).toBeLessThan(2500)
      expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(css).not.toMatch(/transition|animation/)
    })
    it(`${label}: !important only on the composer/panel fill properties`, () => {
      for (const r of rs) {
        if (!/!important/.test(r.body)) continue
        expect(r.selector).toMatch(/^\[data-composer-card\]|^\[data-sidebar-right-panel="push"\]\[data-sidebar-right-open\]$/)
        for (const decl of r.body.split(';').filter((d) => d.includes('!important'))) expect(decl.trim()).toMatch(/^background-(color|image)\b/)
      }
    })
  }
  it('the sidebar gets sheen and an inset edge only (its fill is left alone)', () => {
    const rs = rules(glassCss({ tier: 'standard', mode: 'dark', endfield: false }))
    const side = rs.find((r) => r.selector === '[data-slot="sidebar"] > div')!
    expect(side.body).toContain('inset -1px 0 0')
    expect(side.body).not.toMatch(/background-color/)
  })
  it('the dock pane inside the open panel is transparent so the glass shows', () => {
    const rs = rules(glassCss({ tier: 'standard', mode: 'light', endfield: false }))
    expect(rs.some((r) => r.selector.endsWith('[data-dockkit-pane]') && /background-color: transparent/.test(r.body))).toBe(true)
  })
  it('the Endfield look stylesheet no longer paints glass itself', () => {
    for (const mode of ['light', 'dark'] as const) expect(endfieldLookCss(mode)).not.toMatch(/glass|backdrop/)
  })
})

describe('the stylesheet element', () => {
  it('createLookFace(doc, "glass") mounts one tagged <style> and removes it', () => {
    const head = { children: [] as unknown[], appendChild(e: unknown) { this.children.push(e) } }
    const made: { attrs: Record<string, string>; textContent: string; parentNode: unknown; remove(): void; setAttribute(k: string, v: string): void }[] = []
    const doc = { head, createElement: () => { const e = { attrs: {} as Record<string, string>, textContent: '', parentNode: null as unknown, remove() { head.children = head.children.filter((c) => c !== e); e.parentNode = null }, setAttribute(k: string, v: string) { e.attrs[k] = v } }; made.push(e); return e } }
    const face = createLookFace(doc as never, 'glass')
    face.apply('a{}')
    face.apply('a{}')
    expect(made).toHaveLength(1)
    expect(made[0]!.attrs['data-dsh-theme-look']).toBe('glass')
    face.apply(undefined)
    expect(head.children).toHaveLength(0)
  })
})

// ---- host ----
describe('host: the profile defaults route', () => {
  const get = (defaults: { look: 'stock' | 'endfield'; glass: string }) => {
    let body = ''
    const res = { writeHead: () => {}, end: (b?: string) => { body = b ?? '' } }
    serveLook(() => defaults)({ method: 'GET' } as never, res as never)
    return JSON.parse(body) as unknown
  }
  it('serves look and glass', () => {
    expect(get({ look: 'endfield', glass: 'strong' })).toEqual({ look: 'endfield', glass: 'strong' })
  })
  it('refuses other methods', () => {
    let status = 0
    serveLook(() => ({ look: 'stock', glass: 'auto' }))({ method: 'POST' } as never, { writeHead: (s: number) => { status = s }, end: () => {} } as never)
    expect(status).toBe(405)
  })
})

// ---- controller ----
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function rig(o: { hostDefaults?: { look?: string; glass?: unknown } | undefined; stored?: Record<string, string>; endfieldPresent?: boolean; scheme?: 'light' | 'dark' } = {}) {
  let scheme: 'light' | 'dark' = o.scheme ?? 'light'
  const listeners = new Set<(s: unknown) => void>()
  const emit = () => { for (const l of Array.from(listeners)) l({ preference: 'system', active: { colorScheme: scheme } }) }
  const storage = new Map<string, string>(Object.entries(o.stored ?? {}))
  const glass: (string | undefined)[] = []
  const look: (string | undefined)[] = []
  const fetchImpl = (async (url: string) => {
    if (url === LOOK_URL && o.hostDefaults !== undefined) return { ok: true, text: async () => JSON.stringify(o.hostDefaults) }
    return { ok: false, text: async () => '' }
  }) as unknown as typeof fetch
  const deps = {
    theme: {
      getTheme: () => ({ preference: 'system', active: { colorScheme: scheme } }),
      overrideTokens: () => { emit(); return () => { emit() } },
    },
    onThemeChange: (l: never) => { listeners.add(l); return () => { listeners.delete(l) } },
    storage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } },
    hostname: '100.64.0.1',
    fetchImpl,
    look: { apply: (c: string | undefined) => { look.push(c) } },
    glass: { apply: (c: string | undefined) => { glass.push(c) } },
    ...(o.endfieldPresent === undefined ? {} : { endfield: { present: () => o.endfieldPresent, subscribe: () => () => {}, bridge: () => {} } }),
  } as unknown as ControllerDeps
  const c = new ThemeController(deps)
  return { c, storage, glass, look, setScheme: (m: 'light' | 'dark') => { scheme = m; emit() }, css: () => glass.at(-1), tier: (): Glass => c.getSnapshot().glass }
}

describe('glass in the controller', () => {
  it('is off by default with the Stock look, and mounts nothing', async () => {
    const r = rig(); r.c.start(); await tick()
    expect(r.tier()).toBe('off')
    expect(r.css()).toBeUndefined()
  })
  it('auto: the Endfield look brings standard glass, with the look\u2019s own variables', async () => {
    const r = rig({ hostDefaults: { look: 'endfield', glass: 'auto' }, scheme: 'dark' }); r.c.start(); await tick(); await tick()
    expect(r.tier()).toBe('standard')
    expect(r.css()).toContain('rgb(var(--edge-glass-fill) / 0.76)') // dark standard
    expect(r.css()).toContain('blur(14px)')
  })
  it('a cached look default keeps today\u2019s appearance before the Host answers', () => {
    const r = rig({ stored: { 'dsh-theme.lookDefault': 'endfield' } }); r.c.start()
    expect(r.tier()).toBe('standard')
    expect(r.css()).toBeDefined()
  })
  it('the profile default `glass:` turns glass on with the Stock look, from tokens, and is cached', async () => {
    const r = rig({ hostDefaults: { look: 'stock', glass: 'subtle' }, scheme: 'light' }); r.c.start(); await tick(); await tick()
    expect(r.tier()).toBe('subtle')
    expect(r.css()).toContain('color-mix(in srgb, var(--dsw-alias-bg-layer-1) 68%, transparent)')
    expect(r.css()).toContain('blur(8px)')
    expect(r.storage.get('dsh-theme.glassDefault')).toBe('subtle')
    expect(r.look.at(-1)).toBeUndefined() // the Endfield look itself stays off
  })
  it('profile `glass: off` turns the Endfield look\u2019s glass off', async () => {
    const r = rig({ hostDefaults: { look: 'endfield', glass: 'off' } }); r.c.start(); await tick(); await tick()
    expect(r.tier()).toBe('off')
    expect(r.css()).toBeUndefined()
    expect(r.look.at(-1)).toBeDefined()
  })
  it('a browser choice wins over the profile both ways; Profile default restores it; the choice is stored', async () => {
    const r = rig({ hostDefaults: { look: 'stock', glass: 'strong' } }); r.c.start(); await tick(); await tick()
    expect(r.tier()).toBe('strong')
    r.c.setGlass('off')
    expect(r.tier()).toBe('off')
    expect(r.css()).toBeUndefined()
    expect(r.storage.get('dsh-theme.glass')).toBe('off')
    r.c.setGlass('standard')
    expect(r.css()).toContain('blur(14px)')
    r.c.setGlass('default')
    expect(r.tier()).toBe('strong')
    expect(r.css()).toContain('blur(22px)')
    r.c.setGlass('nonsense' as never)
    expect(r.storage.get('dsh-theme.glass')).toBe('default')
  })
  it('a stored browser choice applies at construction, ignoring junk', () => {
    expect(rig({ stored: { 'dsh-theme.glass': 'strong' } }).tier()).toBe('strong')
    expect(rig({ stored: { 'dsh-theme.glass': 'bogus' } }).c.getSnapshot().glassChoice).toBe('default')
  })
  it('works with an Omarchy-like palette and with the look on or off', async () => {
    const r = rig({ hostDefaults: { look: 'stock', glass: 'standard' }, stored: { 'dsh-theme.choice': 'catppuccin-mocha' } }); r.c.start(); await tick(); await tick()
    expect(r.css()).toContain('blur(14px)')
    expect(r.css()).toContain('76%') // dark palette alpha
    r.c.setLook('endfield')
    expect(r.css()).toContain('rgb(var(--edge-glass-fill) / 0.76)')
  })
  it('Stock colours follow Appearance: the stylesheet is rebuilt when the scheme flips', async () => {
    const r = rig({ hostDefaults: { look: 'stock', glass: 'standard' }, scheme: 'light' }); r.c.start(); await tick(); await tick()
    expect(r.css()).toContain('80%')
    expect(r.css()).toContain('rgb(255 255 255 / 0.65)')
    r.setScheme('dark')
    expect(r.css()).toContain('76%')
    expect(r.css()).toContain('rgb(255 255 255 / 0.18)')
  })
  it('explicit glass still works while the real dsh-theme-endfield is on the page, and auto is then off', async () => {
    const auto = rig({ hostDefaults: { look: 'endfield', glass: 'auto' }, endfieldPresent: true }); auto.c.start(); await tick(); await tick()
    expect(auto.tier()).toBe('off')
    const explicit = rig({ endfieldPresent: true, stored: { 'dsh-theme.glass': 'subtle' } }); explicit.c.start(); await tick()
    expect(explicit.tier()).toBe('subtle')
  })
  it('an old Host without `glass` keeps the cached/auto value; an unknown value is ignored', async () => {
    const old = rig({ hostDefaults: { look: 'endfield' } }); old.c.start(); await tick(); await tick()
    expect(old.c.getSnapshot().glassDefault).toBe('auto')
    const junk = rig({ hostDefaults: { glass: 'frosted' }, stored: { 'dsh-theme.glassDefault': 'strong' } }); junk.c.start(); await tick(); await tick()
    expect(junk.c.getSnapshot().glassDefault).toBe('strong')
  })
  it('disposing removes the stylesheet', async () => {
    const r = rig({ hostDefaults: { look: 'stock', glass: 'strong' } }); const stop = r.c.start(); await tick(); await tick()
    expect(r.css()).toBeDefined()
    stop()
    expect(r.css()).toBeUndefined()
  })
})

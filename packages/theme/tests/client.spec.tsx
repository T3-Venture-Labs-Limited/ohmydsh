import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'
import { locale } from '../src/client/locale.ts'

function fakeCtx() {
  const dicts = new Map<string, Record<string, string>>()
  const registered: { name: string; id?: string }[] = []
  const slots = {
    inject: (_name: string, factory: () => unknown) => { factory() },
    register: (opts: { name: string; id?: string }) => { registered.push(opts); return () => {} },
  }
  const disposers: (() => void)[] = []
  const layers = new Map<string, unknown>()
  let preference = 'system'
  const shells = new Set<string>()
  const setTheme = vi.fn((id: string) => { preference = id })
  const theme = {
    getTheme: () => ({ preference }),
    setTheme,
    overrideTokens: (s: string, t: unknown) => { layers.set(s, t); return () => { layers.delete(s) } },
  }
  const ctx = {
    effect: vi.fn((fn: () => unknown) => { const off = fn(); if (typeof off === 'function') disposers.push(off as () => void) }),
    on: vi.fn(() => () => {}),
    inject: vi.fn(),
    locale: {
      register: (ns: string, _l: string, d: Record<string, string>) => { dicts.set(ns, d); return () => dicts.delete(ns) },
      bind: (ns: string) => (key: string) => dicts.get(ns)?.[key] ?? key,
    },
    slots,
    theme,
  }
  return { ctx, dicts, registered, disposers, layers, shells, setTheme }
}

describe('client apply', () => {
  it('declares the services it needs', () => {
    expect(inject).toEqual(['slots', 'locale', 'theme'])
  })
  it('registers the dictionary and the settings page', () => {
    const { ctx, dicts, registered } = fakeCtx()
    apply(ctx as never)
    expect(dicts.get(locale.ns)).toEqual(locale.en)
    expect(registered.map((r) => r.name)).toEqual(['settings.section'])
  })
  it('registers no shell themes and never writes Appearance; one disposer ends the controller', () => {
    const { ctx, disposers, layers, shells, setTheme } = fakeCtx()
    apply(ctx as never)
    expect(shells.size).toBe(0)
    for (const d of disposers) d()
    expect(layers.size).toBe(0)
    expect(setTheme).not.toHaveBeenCalled()
  })
})

describe('locale', () => {
  it('has no empty English strings', () => {
    for (const [key, value] of Object.entries(locale.en)) expect(value.length, key).toBeGreaterThan(0)
  })
})

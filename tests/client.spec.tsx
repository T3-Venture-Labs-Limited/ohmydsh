import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'
import { locale } from '../src/client/locale.ts'

function fakeCtx() {
  const dicts = new Map<string, Record<string, string>>()
  const registered: { name: string; id?: string; key?: string }[] = []
  const slots = {
    inject: (_name: string, factory: () => unknown) => { factory() },
    register: (opts: { name: string; id?: string; key?: string }) => { registered.push(opts); return () => {} },
  }
  const ctx = {
    effect: vi.fn((fn: () => unknown) => fn()),
    locale: {
      register: (ns: string, _l: string, d: Record<string, string>) => { dicts.set(ns, d); return () => dicts.delete(ns) },
      bind: (ns: string) => (key: string) => dicts.get(ns)?.[key] ?? key,
    },
    slots,
  }
  return { ctx, dicts, registered }
}

describe('client apply', () => {
  it('declares the services it needs', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })
  it('registers the dictionary and the two slots through slots.inject', () => {
    const { ctx, dicts, registered } = fakeCtx()
    apply(ctx as never)
    expect(dicts.get(locale.ns)).toEqual(locale.en)
    expect(registered.map((r) => r.name)).toEqual(['sidebar.panellist', 'main'])
    expect(ctx.effect).toHaveBeenCalledTimes(1)
  })
})

describe('locale', () => {
  it('has no empty English strings', () => {
    for (const [key, value] of Object.entries(locale.en)) expect(value.length, key).toBeGreaterThan(0)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'
import { locale } from '../src/client/locale.ts'

describe('client apply', () => {
  it('declares the services it needs', () => { expect(inject).toEqual(['slots', 'locale']) })
  it('registers the dictionary and one settings section through slots.inject', () => {
    const dicts = new Map<string, Record<string, string>>()
    const registered: { name: string; id?: string }[] = []
    const ctx = {
      effect: vi.fn((fn: () => unknown) => fn()),
      locale: { register: (ns: string, _l: string, d: Record<string, string>) => { dicts.set(ns, d); return () => dicts.delete(ns) }, bind: (ns: string) => (k: string) => dicts.get(ns)?.[k] ?? k },
      slots: { inject: (_n: string, f: () => unknown) => { f() }, register: (o: { name: string; id?: string }) => { registered.push(o); return () => {} } },
    }
    apply(ctx as never)
    expect(dicts.get(locale.ns)).toEqual(locale.en)
    expect(registered.map((r) => r.name)).toEqual(['settings.section'])
  })
  it('has no empty English strings', () => { for (const [k, v] of Object.entries(locale.en)) expect(v.length, k).toBeGreaterThan(0) })
})

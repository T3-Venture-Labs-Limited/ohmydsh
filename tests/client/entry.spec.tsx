import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, makeOpenSession } from '../../src/client/index.tsx'
import { locale } from '../../src/client/locale.ts'

function fakeCtx(services: Record<string, unknown> = {}) {
  const dicts = new Map<string, Record<string, string>>()
  const registered: { name: string; id?: string; key?: string; order?: number; label?: () => string }[] = []
  const slots = {
    inject: (_name: string, factory: () => unknown) => { factory() },
    register: (opts: (typeof registered)[number]) => { registered.push(opts); return () => {} },
  }
  const ctx = {
    effect: vi.fn((fn: () => unknown) => fn()),
    get: vi.fn((name: string) => services[name]),
    locale: {
      register: (ns: string, _l: string, d: Record<string, string>) => { dicts.set(ns, d); return () => dicts.delete(ns) },
      bind: (ns: string) => (key: string) => dicts.get(ns)?.[key] ?? key,
    },
    slots,
  }
  return { ctx, dicts, registered }
}

afterEach(() => { history.replaceState(null, '', location.pathname) })

describe('client apply', () => {
  it('declares the services it needs', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })
  it('registers the dictionary, the sidebar entry right after Automation tasks, and the main page; no settings section', () => {
    const { ctx, dicts, registered } = fakeCtx()
    apply(ctx as never)
    expect(dicts.get(locale.ns)).toEqual(locale.en)
    expect(registered.map((r) => r.name)).toEqual(['sidebar.panellist', 'main'])
    expect(registered[0]).toMatchObject({ id: 'dsh-triggers', order: 11 })
    expect(registered[0]?.label?.()).toBe('Triggers')
    expect(registered[1]).toMatchObject({ key: 'dsh-triggers' })
    expect(ctx.effect).toHaveBeenCalledTimes(1)
  })
})

describe('open chat navigation', () => {
  it('uses uiWorkspace.openSession when the service is there (read at click time)', () => {
    const openSession = vi.fn()
    const services: Record<string, unknown> = {}
    const { ctx } = fakeCtx(services)
    const open = makeOpenSession(ctx as never)
    services.uiWorkspace = { openSession }
    open('sess-42')
    expect(openSession).toHaveBeenCalledWith('sess-42')
    expect(location.hash).toBe('')
  })
  it("falls back to dsh-hud's hash fragment without the service, or when ctx.get throws", () => {
    const { ctx } = fakeCtx()
    makeOpenSession(ctx as never)('sess-1')
    expect(location.hash).toBe('#dsh-hud-session=sess-1')
    history.replaceState(null, '', location.pathname)
    makeOpenSession({ get: () => { throw new Error('no service') } } as never)('sess-2')
    expect(location.hash).toBe('#dsh-hud-session=sess-2')
  })
})

describe('locale', () => {
  it('has no empty English strings', () => {
    for (const [key, value] of Object.entries(locale.en)) expect(value.length, key).toBeGreaterThan(0)
  })
})

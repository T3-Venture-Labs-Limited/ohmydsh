import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { apply, inject, pageConfig } from '../src/client/index.tsx'
import { locale } from '../src/client/locale.ts'
import { Attribution } from '../src/client/attribution.tsx'
import { BrandMark, BrandWordmark, WORDMARK_HEIGHT } from '../src/client/marks.tsx'
import { GLOBAL_NAME, HARNESS_URL } from '../src/shared/config.ts'

interface Reg { opts: Record<string, unknown>; component: (props: never) => unknown }

function fakeCtx() {
  const dicts = new Map<string, Record<string, string>>()
  const registered: Reg[] = []
  const slots = {
    inject: (_name: string, factory: () => unknown) => { factory() },
    register: (opts: Record<string, unknown>, component: Reg['component']) => { registered.push({ opts, component }); return () => {} },
  }
  const disposers: (() => void)[] = []
  const ctx = {
    effect: (fn: () => unknown) => { const off = fn(); if (typeof off === 'function') disposers.push(off as () => void) },
    locale: {
      register: (ns: string, _l: string, d: Record<string, string>) => { dicts.set(ns, d); return () => dicts.delete(ns) },
      bind: (ns: string) => (key: string) => dicts.get(ns)?.[key] ?? key,
    },
    slots,
  }
  return { ctx, dicts, registered, disposers }
}

const setConfig = (value: unknown): void => { (globalThis as Record<string, unknown>)[GLOBAL_NAME] = value }

describe('client apply', () => {
  it('declares the services it needs', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the sidebar mark and name, the hero mark and the Settings credit; all single slots shadow the stock occupant', () => {
    setConfig(undefined)
    const { ctx, dicts, registered } = fakeCtx()
    apply(ctx as never)
    expect(dicts.get(locale.ns)).toEqual(locale.en)
    expect(registered.map((r) => r.opts['name'])).toEqual(['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark', 'settings.general.item'])
    for (const r of registered.filter((x) => x.opts['name'] !== 'settings.general.item')) expect(r.opts['priority'], String(r.opts['name'])).toBe(-1)
  })

  it('showAttribution:false drops the credit and nothing else', () => {
    setConfig({ enabled: true, showAttribution: false })
    const { ctx, registered } = fakeCtx()
    apply(ctx as never)
    expect(registered.map((r) => r.opts['name'])).toEqual(['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'])
    setConfig(undefined)
  })

  it('enabled:false registers nothing', () => {
    setConfig({ enabled: false })
    const { ctx, registered, dicts } = fakeCtx()
    apply(ctx as never)
    expect(registered).toEqual([])
    expect(dicts.size).toBe(0)
    setConfig(undefined)
  })

  it('reads the page global and defaults on junk', () => {
    expect(pageConfig({ [GLOBAL_NAME]: { enabled: false, showAttribution: false } })).toEqual({ enabled: false, showAttribution: false })
    expect(pageConfig({ [GLOBAL_NAME]: 'nope' })).toEqual({ enabled: true, showAttribution: true })
    expect(pageConfig({})).toEqual({ enabled: true, showAttribution: true })
  })
})

describe('marks', () => {
  it('the mark respects size and paints with theme tokens, never a literal colour', () => {
    const html = renderToStaticMarkup(<BrandMark size={34} />)
    expect(html).toContain('width="34"')
    expect(html).toContain('height="34"')
    expect(html).toContain('var(--dsw-alias-brand-primary')
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(renderToStaticMarkup(<BrandMark size={16} />)).toContain('width="16"')
  })
  it('passes the hero className through', () => {
    expect(renderToStaticMarkup(<BrandMark size={34} className="fish" />)).toContain('class="fish"')
  })
  it('the wordmark has a fixed height and a name for assistive tech', () => {
    const html = renderToStaticMarkup(<BrandWordmark title="x" />)
    expect(html).toContain(`height="${WORDMARK_HEIGHT}"`)
    expect(html).toContain('aria-label="ohmydsh"')
    expect(html).toContain('var(--dsw-alias-label-primary')
  })
})

describe('attribution', () => {
  it('says what ohmydsh is built on, links to DeepSeek, and does not imply endorsement', () => {
    const { ctx, dicts } = fakeCtx()
    locale.register(ctx.locale as never)
    const t = locale.bind(ctx.locale as never)
    const html = renderToStaticMarkup(<Attribution t={t} />)
    expect(dicts.size).toBe(1)
    expect(html).toContain('Built on')
    expect(html).toContain('DeepSeek Harness')
    expect(html).toContain(`href="${HARNESS_URL}"`)
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toMatch(/did not make it and does not endorse/)
  })
})

describe('locale', () => {
  it('has no empty English strings', () => {
    for (const [key, value] of Object.entries(locale.en)) expect(value.length, key).toBeGreaterThan(0)
  })
})

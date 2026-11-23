import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, inject, pageConfig } from '../src/client/index.tsx'
import { locale } from '../src/client/locale.ts'
import { STYLE_ID } from '../src/client/styles.ts'
import { GLOBAL_NAME } from '../src/shared/config.ts'
import { approvalCard, key } from './fixtures.ts'

function fakeCtx() {
  const dicts = new Map<string, Record<string, string>>()
  const disposers: (() => void)[] = []
  const commands: string[] = []
  const fixed: string[] = []
  const catalogListeners = new Set<() => void>()
  const ctx = {
    effect: (fn: () => unknown) => { const off = fn(); if (typeof off === 'function') disposers.push(off as () => void) },
    locale: {
      register: (ns: string, _l: string, d: Record<string, string>) => { dicts.set(ns, d); return () => dicts.delete(ns) },
      bind: (ns: string) => (k: string, p?: Record<string, string | number>) => (dicts.get(ns)?.[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(p?.[n] ?? '')),
    },
    shortcuts: {
      runtime: 'desktop', platform: 'linux',
      catalog: { getSnapshot: () => [{ id: 'ohmydsh.keys.focus', keys: ['Ctrl', 'Alt', 'J'], binding: {} }], subscribe: (l: () => void) => { catalogListeners.add(l); return () => catalogListeners.delete(l) } },
      register: (c: { id: string }) => { commands.push(c.id); return () => {} },
      registerFixed: (c: { id: string }) => { fixed.push(c.id); return () => {} },
      observeFixedInput: () => () => {},
    },
  }
  return { ctx, dicts, disposers, commands, fixed, catalogListeners }
}

const setConfig = (value: unknown): void => { (globalThis as Record<string, unknown>)[GLOBAL_NAME] = value }
// jsdom has no layout: say every element is laid out (the real check is getClientRects().length > 0).
const realRects = Element.prototype.getClientRects
beforeEach(() => { Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList })
afterEach(() => { Element.prototype.getClientRects = realRects; setConfig(undefined); document.body.innerHTML = ''; document.getElementById(STYLE_ID)?.remove() })

describe('client apply', () => {
  it('declares the services it needs and nothing heavy', () => {
    expect(inject).toEqual(['locale', 'shortcuts'])
  })

  it('registers the dictionary, the stylesheet, the keyboard listener and the shortcuts; the disposers remove them all', () => {
    const { ctx, dicts, disposers, commands, fixed } = fakeCtx()
    const a = approvalCard()
    document.body.append(a.root)
    apply(ctx as never)
    expect(dicts.get(locale.ns)).toEqual(locale.en)
    expect(document.getElementById(STYLE_ID)).not.toBeNull()
    expect(commands).toEqual(['ohmydsh.keys.focus'])
    expect(fixed.length).toBe(6)
    const body = a.root.querySelector<HTMLElement>('[data-approval-scroll]')!
    expect(document.activeElement).toBe(body)
    key(body, '1')
    expect(a.clicks).toEqual(['Allow once'])
    for (const off of disposers) off()
    expect(document.getElementById(STYLE_ID)).toBeNull()
    expect(dicts.size).toBe(0)
    key(body, '1')
    expect(a.clicks).toEqual(['Allow once'])
  })

  it('enabled:false registers nothing', () => {
    setConfig({ enabled: false })
    const { ctx, dicts, commands, fixed } = fakeCtx()
    apply(ctx as never)
    expect(dicts.size).toBe(0)
    expect(commands).toEqual([])
    expect(fixed).toEqual([])
    expect(document.getElementById(STYLE_ID)).toBeNull()
  })

  it('reads the page global and defaults on junk', () => {
    expect(pageConfig({ [GLOBAL_NAME]: { enabled: false, autoFocus: false } })).toEqual({ enabled: false, autoFocus: false })
    expect(pageConfig({ [GLOBAL_NAME]: 'nope' })).toEqual({ enabled: true, autoFocus: true })
    expect(pageConfig({})).toEqual({ enabled: true, autoFocus: true })
  })

  it('a changed shortcut label refreshes the hint of a waiting card', () => {
    setConfig({ enabled: true, autoFocus: false })
    const { ctx, catalogListeners } = fakeCtx()
    const a = approvalCard()
    document.body.append(a.root)
    apply(ctx as never)
    expect(a.root.getAttribute('data-ohmydsh-keys-hint')).toBe('Ctrl+Alt+J to answer with the keyboard')
    for (const l of catalogListeners) l()
    expect(a.root.getAttribute('data-ohmydsh-keys-hint')).toBe('Ctrl+Alt+J to answer with the keyboard')
  })
})

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import SettingsPage from '../src/client/settings-page.tsx'
import { ThemeController, LOOK_URL } from '../src/client/controller.ts'
import type { ControllerDeps } from '../src/client/controller.ts'
import { locale } from '../src/client/locale.ts'
import type { T } from '../src/client/locale.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const t: T = (key, params) => locale.en[key].replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''))
const mounted: (() => void)[] = []
afterEach(() => { for (const off of mounted.splice(0)) off() })

function controller(stored: Record<string, string> = {}, glassDefault = 'auto') {
  const storage = new Map(Object.entries(stored))
  const css: (string | undefined)[] = []
  const deps = {
    theme: { getTheme: () => ({ preference: 'system', active: { colorScheme: 'light' } }), overrideTokens: () => () => {} },
    onThemeChange: () => () => {},
    storage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } },
    hostname: '100.64.0.1',
    fetchImpl: (async (url: string) => url === LOOK_URL ? { ok: true, text: async () => JSON.stringify({ look: 'stock', glass: glassDefault }) } : { ok: false, text: async () => '' }) as unknown as typeof fetch,
    glass: { apply: (c: string | undefined) => { css.push(c) } },
  } as unknown as ControllerDeps
  const c = new ThemeController(deps)
  c.start()
  return { c, storage, css }
}

async function render(c: ThemeController): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(() => { act(() => { root.unmount() }); host.remove() })
  await act(async () => { root.render(<SettingsPage t={t} controller={c} />) })
  return host
}

const select = (host: HTMLElement): HTMLSelectElement => host.querySelector<HTMLSelectElement>('select#dsh-theme-glass')!
async function pick(host: HTMLElement, value: string): Promise<void> {
  const el = select(host)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('Settings > Theme > Glass', () => {
  it('shows a Glass select with Profile default / Off / Subtle / Standard / Strong and a one-line description', async () => {
    const { c } = controller()
    const host = await render(c)
    const el = select(host)
    expect(el).not.toBeNull()
    expect(el.getAttribute('aria-label') ?? host.querySelector(`label[for="dsh-theme-glass"]`)?.textContent).toBe('Glass')
    expect([...el.options].map((o) => o.textContent)).toEqual(['Profile default', 'Off', 'Subtle', 'Standard', 'Strong'])
    expect(el.value).toBe('default')
    expect(host.textContent).toContain('See-through composer, sidebar and right panel')
    expect(host.textContent).toContain('Profile default: Auto (Standard with the Endfield look, otherwise Off)')
  })
  it('picking a tier sets this browser\u2019s override and mounts the stylesheet; Profile default restores the profile', async () => {
    const { c, storage, css } = controller({}, 'subtle')
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const host = await render(c)
    expect(host.textContent).toContain('Profile default: Subtle')
    await pick(host, 'strong')
    expect(storage.get('dsh-theme.glass')).toBe('strong')
    expect(css.at(-1)).toContain('blur(22px)')
    expect(select(host).value).toBe('strong')
    await pick(host, 'off')
    expect(css.at(-1)).toBeUndefined()
    await pick(host, 'default')
    expect(storage.get('dsh-theme.glass')).toBe('default')
    expect(css.at(-1)).toContain('blur(8px)')
  })
})

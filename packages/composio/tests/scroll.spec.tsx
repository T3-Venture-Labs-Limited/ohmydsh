// Regression: the global panel's content was cut off below the fold because nothing in the page scrolled (the host's
// main panel clips overflow). The page root must be a bounded, vertically scrolling container.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import Panel from '../src/client/panel.tsx'
import { locale } from '../src/client/locale.ts'

const css = readFileSync(resolve(import.meta.dirname, '../src/client/composio.css'), 'utf8')
const rule = (selector: string): string => new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''

const connections = Array.from({ length: 30 }, (_, i) => ({ slug: `app_${String(i)}`, name: `App ${String(i)}`, logo: null, hasExpired: false, accounts: [{ wordId: `app_${String(i)}_x`, alias: null, status: 'ACTIVE' }] }))
const state = { health: { ok: true, email: 'a@b.c' }, listener: { state: 'live', lastEventAt: null, lastError: null }, paused: false, queued: 0, hasAutomationModels: false, connections, recipes: [], routes: [], orphanTriggers: [], runs: [] }

describe('page scrolling', () => {
  it('css: the root fills the panel, may shrink (min-height 0) and scrolls vertically', () => {
    const body = rule('.co-scroll')
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/height:\s*100%/)
    expect(body).toMatch(/overflow-x:\s*hidden/)
  })
  it('the page content is not width-pinned to a narrow column', () => {
    expect(rule('.dk-page.co-page')).toMatch(/max-width:\s*1120px/)
  })
  it('every Panel state renders inside the scroll container', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, value: state })))))
    const t = (key: string, params?: Record<string, unknown>): string => locale.en[key as keyof typeof locale.en]?.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? '')) ?? key
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<Panel t={t as never} />) })
    expect(host.querySelector('.co-scroll > .dk-page')).not.toBeNull() // loading state
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    const scroll = host.querySelector('.co-scroll')
    expect(scroll).not.toBeNull()
    expect(scroll?.querySelectorAll('.co-app').length).toBe(30)
    expect(host.querySelectorAll('.co-scroll').length).toBe(1)
    act(() => { root.unmount() })
    vi.unstubAllGlobals()
  })
})

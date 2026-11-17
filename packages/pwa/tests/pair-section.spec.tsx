import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PairSection, { ago, formatRemaining } from '../src/client/pair-section.tsx'
import { locale } from '../src/client/locale.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: string, params?: Record<string, string>) => (locale.en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_m, k: string) => params?.[k] ?? '')) as never

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('pair section', () => {
  it('formats time', () => {
    expect(formatRemaining(600_000)).toBe('10:00'); expect(formatRemaining(61_000)).toBe('1:01'); expect(formatRemaining(-5)).toBe('0:00')
    expect(ago(0, 30_000, t)).toBe('just now'); expect(ago(0, 5 * 60_000, t)).toBe('5 min ago'); expect(ago(0, 3 * 3600_000, t)).toBe('3 h ago'); expect(ago(0, 72 * 3600_000, t)).toBe('3 d ago')
  })
  it('shows a QR and link after "Pair a phone", lists devices and removes one', async () => {
    const devices = [{ id: 'a'.repeat(24), name: 'Pixel 8', createdAt: Date.now() - 120_000, lastSeen: Date.now() }]
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { body?: string }) => {
      calls.push(path)
      const body = path === '/pair/devices' ? { ok: true, devices: [...devices] }
        : path === '/pair/code' ? { ok: true, expiresAt: Date.now() + 600_000, origin: 'https://x.ts.net', kind: 'tailscale', secure: true, warnings: ['Plain http note'], links: { app: 'ohmydsh://pair?u=https%3A%2F%2Fx.ts.net&c=abcdefghijklmnopqrstuv', web: 'https://x.ts.net/app/pair#abcdefghijklmnopqrstuv' } }
          : (devices.splice(0), { ok: true, removed: true, echo: init?.body })
      return { ok: true, status: 200, json: async () => body }
    }))
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(<PairSection t={t} />) })
    expect(host.textContent).toContain('Pixel 8')
    const make = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Pair a phone')!
    await act(async () => { make.click() })
    expect(host.querySelector('svg[aria-label="Pairing QR code"] path')).not.toBeNull()
    expect((host.querySelector('input[readonly]') as HTMLInputElement).value).toBe('https://x.ts.net/app/pair#abcdefghijklmnopqrstuv')
    expect(host.textContent).toContain('Valid for 10:00'); expect(host.textContent).toContain('Plain http note')
    const remove = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!
    await act(async () => { remove.click() })
    expect(calls).toContain('/pair/remove'); expect(host.textContent).toContain('No phones paired yet')
    await act(async () => { root.unmount() })
  })
})

// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { cleanUrl, draftFromShare, startBridge, type BridgeDeps } from '../src/client/bridge.ts'

function deps(search: string, over: Partial<BridgeDeps> = {}) {
  const listeners = new Set<(e: MessageEvent) => void>()
  const d = {
    openSession: vi.fn(), startDraft: vi.fn(), currentSessionId: () => 'cur', replaceUrl: vi.fn(),
    location: { pathname: '/', search, hash: '' },
    fetchShare: vi.fn(async () => ({ title: 'T', text: 'Hello', url: 'https://example.com/a', files: [] as { name: string; path: string }[] })),
    isShareableReady: async () => true,
    worker: { addEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => { listeners.add(fn) }, removeEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => { listeners.delete(fn) } },
    ...over,
  } satisfies BridgeDeps
  return { d, post: (data: unknown, ports: unknown[] = []) => { for (const fn of listeners) fn({ data, ports } as unknown as MessageEvent) }, listeners }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('client bridge', () => {
  it('answers the service worker with the current session and opens a session on request (valid ids only)', () => {
    const { d, post, listeners } = deps('')
    const off = startBridge(d)
    const port = { postMessage: vi.fn() }
    post({ type: 'dsh-pwa:current-session' }, [port])
    expect(port.postMessage).toHaveBeenCalledWith({ sessionId: 'cur' })
    post({ type: 'dsh-pwa:open-session', sessionId: 'abc-123' })
    post({ type: 'dsh-pwa:open-session', sessionId: '../x' })
    post({ type: 'other' })
    expect(d.openSession).toHaveBeenCalledTimes(1); expect(d.openSession).toHaveBeenCalledWith('abc-123')
    off(); expect(listeners.size).toBe(0)
  })
  it('?openSession=<id> (a cold start from a notification) opens that session once the lists are ready and cleans the URL', async () => {
    const { d } = deps('?openSession=abc-123&x=1')
    startBridge(d); await settle()
    expect(d.openSession).toHaveBeenCalledWith('abc-123'); expect(d.replaceUrl).toHaveBeenCalledWith('/?x=1')
    const bad = deps('?openSession=%2e%2e%2fx'); startBridge(bad.d); await settle()
    expect(bad.d.openSession).not.toHaveBeenCalled()
  })
  it('?share=<id> pre-fills a draft in a new session and never sends; a missing share does nothing', async () => {
    const { d } = deps('?share=' + 'a'.repeat(24))
    startBridge(d); await settle()
    expect(d.startDraft).toHaveBeenCalledWith('T\nHello\nhttps://example.com/a')
    expect(d.replaceUrl).toHaveBeenCalledWith('/')
    const none = deps('?share=' + 'b'.repeat(24), { fetchShare: async () => undefined }); startBridge(none.d); await settle()
    expect(none.d.startDraft).not.toHaveBeenCalled()
    const bad = deps('?share=nope'); startBridge(bad.d); await settle()
    expect(bad.d.fetchShare).not.toHaveBeenCalled()
  })
  it('does nothing after dispose', async () => {
    const { d } = deps('?openSession=abc', { isShareableReady: () => new Promise((r) => setTimeout(() => r(true), 5)) })
    startBridge(d)()
    await new Promise((r) => setTimeout(r, 15))
    expect(d.openSession).not.toHaveBeenCalled()
  })
  it('draftFromShare joins title, text, link without repeats, and lists saved files', () => {
    expect(draftFromShare({ title: 'A', text: 'A https://x.test', url: 'https://x.test', files: [{ name: 'f.txt', path: '/w/.dsh-shares/1/f.txt' }] })).toBe('A\nA https://x.test\n\nShared file: /w/.dsh-shares/1/f.txt')
    expect(cleanUrl({ pathname: '/', search: '?share=1&openSession=2&a=b', hash: '#h' })).toBe('/?a=b#h')
  })
})

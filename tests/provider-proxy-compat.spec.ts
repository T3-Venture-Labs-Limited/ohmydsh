import { afterEach, describe, expect, it, vi } from 'vitest'
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from '../src/openai-compatible.js'

const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }))
afterEach(() => vi.unstubAllGlobals())

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])
const imageUrl = 'https://cdn.example/generated.jpg'
const stubFetch = () => {
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => options?.method === 'POST'
    ? Response.json({ data: [{ url: imageUrl }] })
    : new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const common = { apiKey: 'test-key', baseURL: 'https://provider.example/v1', model: 'image-model', prompt: 'fixture', maxBytes: 1024, signal: AbortSignal.timeout(1000) }

describe('provider downloads use the host fetch configuration', () => {
  it.each(['198.18.1.151', '127.0.0.1'])('delegates DNS and proxy handling to the host for %s', async address => {
    dns.lookup.mockReset().mockResolvedValue([{ address, family: 4 }])
    const fetch = stubFetch()
    await expect(generateOpenAICompatibleImage({ ...common, provider: 'openai-compat' })).resolves.toMatchObject({ data: bytes, mediaType: 'image/jpeg' })
    const downloads = fetch.mock.calls.filter(([url]) => url === imageUrl)
    expect(downloads).toHaveLength(1)
    for (const [, options] of downloads) {
      expect(options).not.toHaveProperty('dispatcher')
      expect(options).not.toHaveProperty('agent')
    }
    expect(dns.lookup).not.toHaveBeenCalled()
  })

  it.each([false, true])('rejects fake/private DNS only with strict opt-in (enabled=%s)', async enabled => {
    dns.lookup.mockReset().mockResolvedValue([{ address: '198.18.1.151', family: 4 }])
    const fetch = stubFetch()
    const strict = { ...common, strictImageDownloads: enabled }
    const sourceImages = [{ data: new Uint8Array([1]), mediaType: 'image/png' as const }]
    const calls = [
      () => generateOpenAICompatibleImage({ ...strict, provider: 'openai-compat' }),
      () => editOpenAICompatibleImage({ ...strict, sourceImages }),
    ]
    for (const call of calls) {
      if (enabled) await expect(call()).rejects.toThrow(/not a public address/)
      else await expect(call()).resolves.toMatchObject({ data: bytes, mediaType: 'image/jpeg' })
    }
    expect(fetch.mock.calls.filter(([url]) => url === imageUrl)).toHaveLength(enabled ? 0 : 2)
    if (enabled) expect(dns.lookup).toHaveBeenCalled()
    else expect(dns.lookup).not.toHaveBeenCalled()
  })
})

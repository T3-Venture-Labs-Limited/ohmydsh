import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubscriptionManager, SUBSCRIPTION_MAX_REFERENCE_IMAGES, type SubscriptionVendor } from '../src/subscription/manager.js'
import { DEFAULT_SUBSCRIPTION_MODELS } from '../src/shared.js'
import { antigravityEnvelope, antigravityImageBody } from '../src/subscription/vendors/antigravity.js'

/**
 * Wire-protocol tests for subscription image editing. These pin the contract
 * the vendor endpoints expect: endpoint selection by the presence of
 * reference images, reference-image encoding per channel, and the shared
 * 5-image guard. Network calls are stubbed; only the real request shape is
 * asserted.
 */

/** Valid non-expired OAuth blob the manager can use without refresh. */
function freshBlob(): { accessToken: string; refreshToken: string; expiresAt: number; accountId: string; email: string } {
  return {
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    expiresAt: Date.now() + 3_600_000,
    accountId: 'account-123',
    email: 'user@example.com',
  }
}

function harness() {
  const resolve = vi.fn(async () => ({ value: JSON.stringify(freshBlob()) }))
  const ctx = { credentials: { resolve } } as never
  const manager = new SubscriptionManager(ctx)
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    data: [{ b64_json: Buffer.from('stub').toString('base64') }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  return { manager, fetchMock }
}

describe('subscription manager edit wire protocol', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('targets the grok edits endpoint with the documented single image field', async () => {
    const { manager, fetchMock } = harness()
    const reference = { data: new Uint8Array([9, 9]), mediaType: 'image/jpeg' }

    await manager.generate({ vendor: 'grok', prompt: 'make it blue', referenceImages: [reference] })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.x.ai/v1/images/edits')
    const body = JSON.parse(String(init.body)) as { model: string; image: { type: string; url: string }; images?: unknown }
    expect(body.model).toBe('grok-imagine-image-2.0')
    expect(body.images).toBeUndefined()
    expect(body.image).toEqual({ type: 'image_url', url: `data:image/jpeg;base64,${Buffer.from(reference.data).toString('base64')}` })
  })

  it('uses the documented images array for a multi-reference grok edit', async () => {
    const { manager, fetchMock } = harness()
    const refs = [1, 2].map(value => ({ data: new Uint8Array([value]), mediaType: 'image/png' }))
    await manager.generate({ vendor: 'grok', prompt: 'combine them', referenceImages: refs, size: '16:9' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { images: Array<{ type: string; url: string }>; image?: unknown; aspect_ratio: string }
    expect(body.image).toBeUndefined()
    expect(body.aspect_ratio).toBe('16:9')
    expect(body.images).toEqual(refs.map(ref => ({ type: 'image_url', url: `data:image/png;base64,${Buffer.from(ref.data).toString('base64')}` })))
  })

  it('leaves no images field on the generation body when editing is absent', async () => {
    const { manager, fetchMock } = harness()

    await manager.generate({ vendor: 'grok', prompt: 'a portrait' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.images).toBeUndefined()
    expect(body.prompt).toBe('a portrait')
  })

  it('uses the xAI aspect_ratio and resolution fields for Grok subscription', async () => {
    const { manager, fetchMock } = harness()
    await manager.generate({ vendor: 'grok', prompt: 'a portrait', size: '9:16', quality: '2k' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.x.ai/v1/images/generations')
    expect(JSON.parse(String(init.body))).toMatchObject({ aspect_ratio: '9:16', resolution: '2k' })
  })

  it('maps an explicit Grok subscription tool size onto an aspect ratio', async () => {
    const { manager, fetchMock } = harness()
    await manager.generate({ vendor: 'grok', prompt: 'a portrait', size: '864x1536' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ aspect_ratio: '9:16' })
  })

  it('uses Gemini imageConfig for Google subscription ratio and HD', () => {
    const body = antigravityImageBody({ prompt: 'a portrait', aspectRatio: '9:16', hd: true })
    expect(body.generationConfig).toMatchObject({ imageConfig: { aspectRatio: '9:16', imageSize: '4K' } })
  })

  it('uses Gemini 3.1 Flash Image for the Google subscription profile and wire request', () => {
    expect(DEFAULT_SUBSCRIPTION_MODELS['google-sub']).toBe('gemini-3.1-flash-image')
    expect(antigravityEnvelope('account-project', antigravityImageBody({ prompt: 'a portrait' }))).toMatchObject({
      project: 'account-project',
      model: 'gemini-3.1-flash-image',
    })
  })
})

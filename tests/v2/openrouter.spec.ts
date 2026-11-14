import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AdapterError, type AdapterContext, type ModelDescriptor, type OperationRequest } from '../../src/v2/contracts.js'
import { OpenRouterAdapter, expiryOf, imageModelFromCatalog, videoModelFromCatalog, videoPricing } from '../../src/v2/providers/openrouter.js'

const fx = (name: string): string => readFileSync(new URL(`./fixtures/openrouter/${name}`, import.meta.url), 'utf8')
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

interface Call { url: string; init: RequestInit }
function harness(routes: (url: string, init: RequestInit) => Response | Promise<Response>, ...keyArg: [] | [string | undefined]) {
  const key = keyArg.length === 0 ? 'sk-or-secret' : keyArg[0]
  const calls: Call[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return routes(String(url), init ?? {}) }) as typeof fetch
  const cache = new Map<string, { fetchedAt: number; payload: string }>()
  const adapter = new OpenRouterAdapter({ apiKey: async () => key, fetch: fetchFn, cache: { get: k => cache.get(k), put: (k, p, t) => { cache.set(k, { fetchedAt: t, payload: p }) } } })
  const context: AdapterContext = { signal: new AbortController().signal, fetch: fetchFn, readInput: async () => ({ bytes: PNG, mediaType: 'image/png', width: 1, height: 1 }) }
  return { adapter, calls, context, cache }
}
const catalogRoutes = (url: string): Response => url.endsWith('/images/models') ? new Response(fx('images-models.json')) : url.endsWith('/videos/models') ? new Response(fx('videos-models.json')) : new Response('{}', { status: 404 })
const req = (patch: Partial<OperationRequest>): OperationRequest => ({ op: 'generate', modelId: '', inputs: {}, params: {}, ...patch })

describe('OpenRouter catalog', () => {
  it('merges curated presets with the live catalog and caches the discovery for 24 h', async () => {
    const h = harness(catalogRoutes)
    const models = await h.adapter.listModels()
    expect(models.length).toBeGreaterThan(60)
    const nb = models.find(m => m.id === 'openrouter:google/gemini-nano-banana-2.1')!
    expect(nb).toMatchObject({ curated: true, tier: 'value', capabilities: ['t2i', 'i2i'], async: 'sync' })
    expect(nb.params.map(p => p.key)).toEqual(['aspect_ratio', 'resolution', 'seed']) // n is gone: the model accepts one image per call
    const veo = models.find(m => m.id === 'openrouter:google/veo-3.1-fast')!
    expect(veo).toMatchObject({ curated: true, async: 'job' })
    expect(veo.capabilities).toEqual(expect.arrayContaining(['t2v', 'i2v', 'first-last-frame']))
    expect(veo.params.find(p => p.key === 'duration')).toMatchObject({ type: 'enum', values: ['4', '6', '8'] })
    expect(veo.pricing?.unit).toBe('second')
    const up = models.find(m => m.id === 'openrouter:black-forest-labs/flux-video-upscale')!
    expect(up.capabilities).toEqual(['upscale-video'])
    expect(up.params.find(p => p.key === 'upscale_factor')).toMatchObject({ min: 1.5, max: 3 })
    const before = h.calls.length
    await h.adapter.listModels()
    expect(h.calls.length).toBe(before)
  })

  it('still lists the curated image models when discovery fails', async () => {
    const h = harness(() => new Response('', { status: 503 }))
    const models = await h.adapter.listModels({ refresh: true })
    expect(models.some(m => m.id === 'openrouter:google/gemini-nano-banana-2.1')).toBe(true)
    expect(models.every(m => m.curated)).toBe(true)
  })

  it('maps catalog entries to capabilities and params', () => {
    const images = JSON.parse(fx('images-models.json')).data as Parameters<typeof imageModelFromCatalog>[0][]
    const mapped = images.map(i => imageModelFromCatalog(i, '2026-11-13')).filter((m): m is ModelDescriptor => m !== undefined)
    expect(mapped.length).toBe(images.length)
    expect(mapped.every(m => m.capabilities.includes('t2i'))).toBe(true)
    expect(mapped.some(m => m.capabilities.includes('i2i'))).toBe(true)
    const videos = JSON.parse(fx('videos-models.json')).data as Parameters<typeof videoModelFromCatalog>[0][]
    const vm = videos.map(v => videoModelFromCatalog(v, '2026-11-13'))
    expect(vm.filter(m => m.capabilities.includes('upscale-video')).length).toBeGreaterThan(0)
    expect(vm.filter(m => m.capabilities.includes('t2v')).length).toBeGreaterThan(10)
    for (const m of vm) for (const p of m.params) if (p.type === 'enum') expect(p.values.length).toBeGreaterThan(0)
  })

  it('derives per-second video pricing from SKUs, including cents', () => {
    expect(videoPricing({ duration_seconds_480p: '0.05', duration_seconds_720p: '0.1', duration_seconds_1080p: '0.2' }, '720p')).toMatchObject({ unit: 'second', usd: 0.1 })
    const veo = videoPricing({ duration_seconds_with_audio: '0.12', duration_seconds_with_audio_4k: '0.30', duration_seconds_without_audio: '0.10' })
    expect(veo).toMatchObject({ unit: 'second' })
    expect(videoPricing({ cents_per_second_output_1080p: '28' }, '1080p')).toMatchObject({ usd: 0.28 })
    expect(videoPricing({ cents_per_megapixel_second_precise: '3.5', cents_per_megapixel_second_creative: '5' })).toEqual({ unit: 'megapixel-second', usd: 0.035, note: 'from cents_per_megapixel_second_precise (cheapest SKU)' })
    expect(videoPricing(null)).toBeUndefined()
  })
})

describe('OpenRouter images', () => {
  const model = (m: ModelDescriptor[], id: string): ModelDescriptor => m.find(x => x.id === id)!

  it('POSTs /images with the documented body, sends references as data URLs and records provider cost', async () => {
    const h = harness((url, init) => { if (url.endsWith('/images') && init.method === 'POST') return new Response(fx('image-response.json')); return catalogRoutes(url) })
    const models = await h.adapter.listModels()
    const nb = model([...models], 'openrouter:google/gemini-nano-banana-2.1')
    const result = await h.adapter.submit(req({ op: 'edit', prompt: 'make it night', inputs: { source: { assetId: 'a1' }, references: [{ assetId: 'a2' }] }, params: { aspect_ratio: '16:9', resolution: '2K', n: 1, seed: 7 } }), nb, h.context)
    expect(result.kind).toBe('done')
    if (result.kind !== 'done') return
    expect(result.cost).toEqual({ usd: 0.011, source: 'provider' })
    expect(result.outputs[0]).toMatchObject({ mediaType: 'image/png', seed: 7 })
    expect(result.outputs[0]!.bytes).toEqual(PNG)
    const post = h.calls.find(c => c.init.method === 'POST')!
    expect(post.url).toBe('https://openrouter.ai/api/v1/images')
    expect((post.init.headers as Record<string, string>).authorization).toBe('Bearer sk-or-secret')
    const body = JSON.parse(String(post.init.body))
    expect(body).toMatchObject({ model: 'google/gemini-nano-banana-2.1', prompt: 'make it night', n: 1, resolution: '2K', aspect_ratio: '16:9', seed: 7 })
    expect('output_format' in body).toBe(false)
    expect(body.input_references).toHaveLength(2)
    expect(body.input_references[0]).toEqual({ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } })
  })

  it('sends output_format only to models that declare it (FLUX 3 rejects it with HTTP 400)', async () => {
    const bodies: Record<string, unknown>[] = []
    const h = harness((url, init) => { if (url.endsWith('/images') && init.method === 'POST') { bodies.push(JSON.parse(String(init.body))); return new Response(fx('image-response.json')) } return catalogRoutes(url) })
    const models = await h.adapter.listModels()
    const flux = models.find(m => m.id === 'openrouter:black-forest-labs/flux-3-image')!
    expect(flux.params.some(p => p.key === 'output_format')).toBe(false)
    await h.adapter.submit(req({ prompt: 'x' }), flux, h.context)
    expect('output_format' in bodies[0]!).toBe(false)
    const declaring = models.find(m => m.params.some(p => p.key === 'output_format'))!
    await h.adapter.submit(req({ prompt: 'x' }), declaring, h.context)
    expect(bodies[1]).toMatchObject({ output_format: 'png' })
  })

  it('maps HTTP failures onto the error taxonomy and never leaks the key', async () => {
    const cases: [number, string, string, boolean][] = [[401, 'auth', 'invalid key sk-or-secret', false], [402, 'quota', 'no credits', false], [429, 'quota', 'slow down', true], [503, 'unavailable', 'overloaded', true], [400, 'moderation', 'blocked by safety policy', false], [400, 'invalid', 'bad param', false]]
    for (const [status, kind, message, retryable] of cases) {
      const h = harness((url) => url.endsWith('/images') ? new Response(JSON.stringify({ error: { message } }), { status }) : catalogRoutes(url))
      const nb = (await h.adapter.listModels()).find(m => m.id === 'openrouter:google/gemini-nano-banana-2.1')!
      const error = await h.adapter.submit(req({ prompt: 'x' }), nb, h.context).catch((e: unknown) => e) as AdapterError
      expect(error).toBeInstanceOf(AdapterError)
      expect({ kind: error.kind, retryable: error.retryable, status: error.status }).toEqual({ kind, retryable, status })
      expect(error.message).not.toContain('sk-or-secret')
    }
  })

  it('treats a transport failure as non-retryable-with-status (the runner will not resubmit)', async () => {
    const h = harness((url) => { if (url.endsWith('/images')) throw new TypeError('fetch failed'); return catalogRoutes(url) })
    const nb = (await h.adapter.listModels()).find(m => m.id === 'openrouter:google/gemini-nano-banana-2.1')!
    const error = await h.adapter.submit(req({ prompt: 'x' }), nb, h.context).catch((e: unknown) => e) as AdapterError
    expect(error.kind).toBe('unavailable'); expect(error.status).toBeUndefined()
  })

  it('fails clearly without a key and validates reference counts', async () => {
    const h = harness(catalogRoutes, undefined)
    expect(await h.adapter.isConfigured()).toBe(false)
    const nb = (await h.adapter.listModels()).find(m => m.id === 'openrouter:google/gemini-nano-banana-2.1')!
    await expect(h.adapter.submit(req({ prompt: 'x' }), nb, h.context)).rejects.toThrow(/OPENROUTER_API_KEY/)
    const many = { assetId: 'a' }
    expect(h.adapter.validate(req({ prompt: 'x', inputs: { references: Array.from({ length: 20 }, () => many) } }), nb)).toEqual([{ path: 'inputs', message: expect.stringContaining('at most 14') }])
    expect(h.adapter.validate(req({ prompt: '  ' }), nb)).toEqual([{ path: 'prompt', message: 'A prompt is required' }])
  })

  it('inpaint sends the mask as the markup overlay and refuses a missing mask', async () => {
    let body: Record<string, unknown> = {}
    const h = harness((url, init) => { if (url.endsWith('/images') && init.method === 'POST') { body = JSON.parse(String(init.body)); return new Response(fx('image-response.json')) } return catalogRoutes(url) })
    const gpt = (await h.adapter.listModels()).find(m => m.id === 'openrouter:openai/gpt-image-2.6-flare')!
    expect(gpt).toMatchObject({ capabilities: expect.arrayContaining(['inpaint']), inpaintMode: 'markup' })
    await expect(h.adapter.submit(req({ op: 'inpaint', prompt: 'x', inputs: { source: { assetId: 'a' } } }), gpt, h.context)).rejects.toThrow(/mask/)
    const sharp = (await import('sharp')).default
    const source = await sharp({ create: { width: 4, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
    const mask = await sharp(Buffer.from([255, 255, 0, 0, 255, 255, 0, 0]), { raw: { width: 4, height: 2, channels: 1 } }).png().toBuffer()
    const context = { ...h.context, readInput: async (ref: { assetId: string }) => ref.assetId === 'a' ? { bytes: new Uint8Array(source), mediaType: 'image/png', width: 4, height: 2 } : { bytes: new Uint8Array(mask), mediaType: 'image/png', width: 4, height: 2 } }
    await h.adapter.submit(req({ op: 'inpaint', prompt: 'x', inputs: { source: { assetId: 'a' }, mask: { assetId: 'm' } } }), gpt, context)
    expect(body.markup).toEqual({ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png/) } })
  })
})

describe('signed URL expiry', () => {
  it('reads expiry from X-Goog and X-Amz signature parameters, preferring an explicit value', () => {
    expect(expiryOf('https://s.example/a?X-Goog-Date=20261113T174704Z&X-Goog-Expires=86389')).toBe(Date.UTC(2026, 10, 13, 17, 47, 4) + 86_389_000)
    expect(expiryOf('https://s.example/a?X-Amz-Date=20261113T000000Z&X-Amz-Expires=3600')).toBe(Date.UTC(2026, 10, 13, 1, 0, 0))
    expect(expiryOf('https://s.example/a?X-Goog-Date=20261113T174704Z&X-Goog-Expires=86389', 42)).toBe(42)
    expect(expiryOf('https://s.example/a')).toBeUndefined()
    expect(expiryOf('not a url')).toBeUndefined()
  })
})

describe('OpenRouter video', () => {
  it('submits the documented video body, then polls and returns authenticated download URLs with cost', async () => {
    let polls = 0
    const h = harness((url, init) => {
      if (url.endsWith('/videos') && init.method === 'POST') return new Response(fx('video-submit.json'), { status: 202 })
      if (url.endsWith('/videos/abc123')) return polls++ < 1 ? new Response(JSON.stringify({ id: 'abc123', status: 'in_progress' })) : new Response(fx('video-completed.json'))
      return catalogRoutes(url)
    })
    const veo = (await h.adapter.listModels()).find(m => m.id === 'openrouter:google/veo-3.1-fast')!
    const submitted = await h.adapter.submit(req({ modelId: veo.id, op: 'animate', prompt: 'waves', inputs: { source: { assetId: 'img' } }, params: { duration: '4', resolution: '720p', aspect_ratio: '16:9', generate_audio: false } }), veo, h.context)
    expect(submitted).toEqual({ kind: 'remote', remote: { id: 'abc123', pollingUrl: 'https://openrouter.ai/api/v1/videos/abc123' }, pollAfterMs: 10_000 })
    const body = JSON.parse(String(h.calls.find(c => c.url.endsWith('/videos'))!.init.body))
    expect(body).toMatchObject({ model: 'google/veo-3.1-fast', prompt: 'waves', duration: 4, resolution: '720p', aspect_ratio: '16:9', generate_audio: false })
    expect(body.frame_images).toEqual([{ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png/) }, frame_type: 'first_frame' }])
    if (submitted.kind !== 'remote') return
    const running = await h.adapter.poll(submitted.remote, veo, h.context)
    expect(running).toMatchObject({ state: 'running' })
    const done = await h.adapter.poll(submitted.remote, veo, h.context)
    expect(done).toMatchObject({ state: 'done', cost: { usd: 0.25, source: 'provider' } })
    if (done.state !== 'done') return
    expect(done.outputs[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/videos/abc123/content?index=0', mediaType: 'video/mp4', headers: { authorization: 'Bearer sk-or-secret' } })
  })

  it('maps failed/cancelled/expired jobs and refuses foreign polling URLs', async () => {
    const h = harness((url) => url.includes('/videos/') ? new Response(JSON.stringify({ status: 'failed', error: 'Blocked by safety filter' })) : catalogRoutes(url))
    const veo = (await h.adapter.listModels()).find(m => m.id === 'openrouter:google/veo-3.1-fast')!
    const failed = await h.adapter.poll({ id: 'x', pollingUrl: 'https://openrouter.ai/api/v1/videos/x' }, veo, h.context)
    expect(failed).toMatchObject({ state: 'failed', error: { kind: 'moderation' } })
    await expect(h.adapter.poll({ id: 'x', pollingUrl: 'https://evil.example/steal' }, veo, h.context)).rejects.toThrow(/outside the OpenRouter API/)
  })

  it('estimates video cost from SKU pricing before submit', async () => {
    const h = harness(catalogRoutes)
    const wan = (await h.adapter.listModels()).find(m => m.id === 'openrouter:alibaba/wan-3.0')!
    expect(h.adapter.estimate(req({ params: { duration: '5', resolution: '720p' } }), wan)).toEqual({ usd: 0.5 })
    expect(h.adapter.estimate(req({ params: { duration: '5', resolution: '1080p' } }), wan)).toEqual({ usd: 1 })
  })

  it('video upscale passes factor, creativity and the source video as a public HTTPS URL (data URLs are rejected upstream)', async () => {
    let body: Record<string, unknown> = {}
    const h = harness((url, init) => { if (url.endsWith('/videos') && init.method === 'POST') { body = JSON.parse(String(init.body)); return new Response(fx('video-submit.json'), { status: 202 }) } return catalogRoutes(url) })
    const up = (await h.adapter.listModels()).find(m => m.id === 'openrouter:black-forest-labs/flux-video-upscale')!
    const withUrl: AdapterContext = { ...h.context, publicUrl: () => 'https://openrouter.ai/api/v1/videos/abc123/content?index=0&sig=x' }
    await h.adapter.submit(req({ op: 'upscale', modelId: up.id, inputs: { video: { assetId: 'v1' } }, params: { upscale_factor: 2, creativity: 0.2 } }), up, withUrl)
    expect(body).toMatchObject({ model: 'black-forest-labs/flux-video-upscale', upscale_factor: 2, creativity: 0.2 })
    expect(body.input_references).toEqual([{ type: 'video_url', video_url: { url: 'https://openrouter.ai/api/v1/videos/abc123/content?index=0&sig=x' } }])
    // No hosted copy known: fail before any spend, with guidance.
    const err = await h.adapter.submit(req({ op: 'upscale', modelId: up.id, inputs: { video: { assetId: 'v2' } }, params: { upscale_factor: 2 } }), up, h.context).catch((e: unknown) => e) as AdapterError
    expect(err).toMatchObject({ kind: 'unsupported' }); expect(err.message).toMatch(/public HTTPS URL/)
    expect(h.calls.filter(c => c.init.method === 'POST')).toHaveLength(1)
  })

  it('completed jobs expose the signed URLs so a later video operation can reference the hosted copy', async () => {
    const completed = JSON.stringify({ id: 'abc123', status: 'completed', unsigned_urls: ['https://openrouter.ai/api/v1/videos/abc123/content?index=0'], urls: ['https://signed.example/abc.mp4?sig=1'], expires_at: '2026-11-14T10:00:00Z', usage: { cost: 0.2 } })
    const h = harness((url) => url.includes('/videos/abc123') ? new Response(completed) : catalogRoutes(url))
    const veo = (await h.adapter.listModels()).find(m => m.id === 'openrouter:google/veo-3.1-fast')!
    const done = await h.adapter.poll({ id: 'abc123', pollingUrl: 'https://openrouter.ai/api/v1/videos/abc123' }, veo, h.context)
    expect(done.state === 'done' && done.outputs[0]!.meta).toEqual({ publicUrl: 'https://signed.example/abc.mp4?sig=1', expiresAt: Date.parse('2026-11-14T10:00:00Z') })
  })
})
void vi

describe('discovery overrides generic curated lists', () => {
  it('offers only the aspect ratios, resolutions and counts each model really accepts', async () => {
    const h = harness((url) => catalogRoutes(url))
    const models = await h.adapter.listModels({ refresh: true })
    const by = (id: string): Record<string, unknown> => Object.fromEntries(models.find(m => m.id === `openrouter:${id}`)!.params.map(p => [p.key, p]))
    const values = (p: unknown): string[] => [...((p as { values: readonly string[] }).values)]
    // qwen: 'auto' and '21:9' are rejected upstream (regression for a live 400)
    expect(values(by('qwen/qwen-image-3').aspect_ratio)).not.toContain('auto')
    expect(values(by('qwen/qwen-image-3').aspect_ratio)).not.toContain('21:9')
    expect(values(by('qwen/qwen-image-3').aspect_ratio)).toContain('1:4')
    expect(values(by('google/gemini-nano-banana-2.1').aspect_ratio)).not.toContain('auto')
    expect(values(by('black-forest-labs/flux-3-image').resolution)).toEqual(['768', '1K', '1.5K', '2K', '4K'])
    // gpt-image declares no resolution: the generic curated one must disappear
    expect('resolution' in by('openai/gpt-image-2.6-flare')).toBe(false)
    expect('quality' in by('openai/gpt-image-2.6-flare')).toBe(true)
    // a model that accepts a single image per call must not offer n > 1
    expect((by('google/gemini-nano-banana-2.1').n as { max?: number } | undefined)?.max ?? 1).toBe(1)
    // defaults are always inside the allowed list
    for (const m of models.filter(x => x.provider === 'openrouter')) for (const p of m.params) if (p.type === 'enum' && p.default !== undefined) expect(p.values, `${m.id}.${p.key}`).toContain(p.default)
  })
})

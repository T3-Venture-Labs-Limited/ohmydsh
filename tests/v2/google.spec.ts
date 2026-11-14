import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AdapterContext, ModelDescriptor, OperationRequest } from '../../src/v2/contracts.js'
import { GoogleDirectAdapter, OMNI_MODEL } from '../../src/v2/providers/google.js'

const fx = (n: string): string => readFileSync(new URL(`./fixtures/google/${n}`, import.meta.url), 'utf8')
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
interface Call { url: string; init: RequestInit }
function harness(routes: (url: string, init: RequestInit) => Response, ...keyArg: [] | [string | undefined]) {
  const key = keyArg.length === 0 ? 'AIza-secret' : keyArg[0]
  const calls: Call[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return routes(String(url), init ?? {}) }) as typeof fetch
  const adapter = new GoogleDirectAdapter({ apiKey: async () => key, fetch: fetchFn, extraImageModels: () => ['gemini-3.1-flash-image', 'bad model!'] })
  const recalled = new Map<string, string>()
  const context: AdapterContext = { signal: new AbortController().signal, fetch: fetchFn, readInput: async () => ({ bytes: PNG, mediaType: 'image/png', width: 1, height: 1 }), recall: (ref, k) => recalled.get(`${ref.assetId}:${k}`) }
  return { adapter, calls, context, recalled }
}
const req = (patch: Partial<OperationRequest>): OperationRequest => ({ op: 'generate', modelId: '', inputs: {}, params: {}, ...patch })
const bodyOf = (c: Call): Record<string, any> => JSON.parse(String(c.init.body)) as Record<string, any>
const find = async (a: GoogleDirectAdapter, remote: string): Promise<ModelDescriptor> => (await a.listModels()).find(m => m.remoteId === remote)!

describe('Google catalog', () => {
  it('lists Nano Banana image models and Omni video with honest capabilities (no inpaint: Gemini has no mask input)', async () => {
    const h = harness(() => new Response('{}'))
    const models = await h.adapter.listModels()
    expect(models.map(m => m.remoteId)).toEqual(['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', OMNI_MODEL])
    expect(models.some(m => m.capabilities.includes('inpaint'))).toBe(false)
    expect(models.find(m => m.remoteId === OMNI_MODEL)).toMatchObject({ async: 'job', capabilities: ['t2v', 'i2v', 'first-last-frame', 'v2v', 'extend'] })
    expect((await find(h.adapter, 'gemini-nano-banana-2.1')).params.find(p => p.key === 'aspect_ratio')).toMatchObject({ values: expect.arrayContaining(['1:8', '21:9']) })
    expect((await find(h.adapter, 'gemini-3-pro-image')).params.find(p => p.key === 'aspect_ratio')).toMatchObject({ values: expect.not.arrayContaining(['1:8']) })
    expect(await harness(() => new Response('{}'), undefined).adapter.isConfigured()).toBe(false)
  })
})

describe('Google images (generateContent)', () => {
  it('posts text + labelled multi-reference parts with imageConfig, authenticates by header only, and returns the inline image', async () => {
    const h = harness(() => new Response(fx('generate-content-image.json')))
    const nb = await find(h.adapter, 'gemini-nano-banana-2.1')
    const r = await h.adapter.submit(req({ op: 'edit', prompt: 'Combine the cat from image 1 with the sofa from image 2', inputs: { source: { assetId: 'a' }, references: [{ assetId: 'b' }] }, params: { aspect_ratio: '16:9', image_size: '2K' } }), nb, h.context)
    expect(r.kind === 'done' && r.outputs[0]).toMatchObject({ mediaType: 'image/png' })
    expect(r.kind === 'done' && r.cost).toEqual({ usd: 0.0336, source: 'estimate' })
    const c = h.calls[0]!
    expect(c.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent')
    expect(c.url).not.toContain('AIza'); expect((c.init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-secret')
    const parts = bodyOf(c).contents[0].parts as Record<string, any>[]
    expect(parts.map(p => (p.text ?? (p.inlineData ? 'IMG' : '?')))).toEqual(['Image 1:', 'IMG', 'Image 2:', 'IMG', 'Combine the cat from image 1 with the sofa from image 2'])
    expect(parts[1]!.inlineData.mimeType).toBe('image/png')
    expect(bodyOf(c).generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } })
  })

  it('a single reference is not labelled; text-to-image sends only the prompt', async () => {
    const h = harness(() => new Response(fx('generate-content-image.json')))
    const nb = await find(h.adapter, 'gemini-nano-banana-2.1')
    await h.adapter.submit(req({ op: 'edit', prompt: 'make it night', inputs: { source: { assetId: 'a' } } }), nb, h.context)
    expect((bodyOf(h.calls[0]!).contents[0].parts as unknown[]).length).toBe(2)
    await h.adapter.submit(req({ prompt: 'a red kite' }), nb, h.context)
    expect(bodyOf(h.calls[1]!).contents[0].parts).toEqual([{ text: 'a red kite' }])
  })

  it('classifies blocked prompts, safety refusals, empty answers, auth and quota errors; never leaks the key', async () => {
    const nb = (a: GoogleDirectAdapter): Promise<ModelDescriptor> => find(a, 'gemini-nano-banana-2.1')
    const blocked = harness(() => new Response(fx('generate-content-blocked.json')))
    await expect(blocked.adapter.submit(req({ prompt: 'x' }), await nb(blocked.adapter), blocked.context)).rejects.toMatchObject({ kind: 'moderation' })
    const refused = harness(() => new Response(fx('generate-content-no-image.json')))
    await expect(refused.adapter.submit(req({ prompt: 'x' }), await nb(refused.adapter), refused.context)).rejects.toMatchObject({ kind: 'moderation', message: expect.stringContaining('IMAGE_SAFETY') })
    const empty = harness(() => new Response('{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}'))
    await expect(empty.adapter.submit(req({ prompt: 'x' }), await nb(empty.adapter), empty.context)).rejects.toMatchObject({ kind: 'invalid' })
    const auth = harness(() => new Response('{"error":{"message":"API key not valid. AIza-secret"}}', { status: 400 }))
    const e = await auth.adapter.submit(req({ prompt: 'x' }), await nb(auth.adapter), auth.context).catch((x: unknown) => x) as Error
    expect(e.message).not.toContain('AIza-secret')
    const quota = harness(() => new Response('{"error":{"message":"quota"}}', { status: 429 }))
    await expect(quota.adapter.submit(req({ prompt: 'x' }), await nb(quota.adapter), quota.context)).rejects.toMatchObject({ kind: 'quota' })
    const nokey = harness(() => new Response('{}'), undefined)
    await expect(nokey.adapter.submit(req({ prompt: 'x' }), await nb(nokey.adapter), nokey.context)).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('GEMINI_API_KEY') })
  })
})

describe('Gemini Omni video (Interactions)', () => {
  const omni = async (a: GoogleDirectAdapter): Promise<ModelDescriptor> => find(a, OMNI_MODEL)

  it('text-to-video: model + plain-string input + response_format with aspect, resolution, duration and uri delivery; inline result carries the interaction id', async () => {
    const h = harness(() => new Response(fx('interaction-video-inline.json')))
    const r = await h.adapter.submit(req({ prompt: 'A marble rolling on a track', params: { duration: 6, resolution: '1080p', aspect_ratio: '9:16' } }), await omni(h.adapter), h.context)
    expect(h.calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect(bodyOf(h.calls[0]!)).toEqual({ model: OMNI_MODEL, input: 'A marble rolling on a track', response_format: { type: 'video', delivery: 'uri', aspect_ratio: '9:16', resolution: '1080p', duration: '6s' } })
    expect(r.kind === 'done' && r.outputs[0]).toMatchObject({ mediaType: 'video/mp4', notes: { interaction: 'v1_abc123' } })
    expect(r.kind === 'done' && r.cost).toEqual({ usd: 0.624, source: 'estimate' })      // 6 s x $0.104
  })

  it('image-to-video and first+last frame send typed image parts before the text; references are appended', async () => {
    const h = harness(() => new Response(fx('interaction-video-inline.json')))
    const m = await omni(h.adapter)
    await h.adapter.submit(req({ op: 'animate', prompt: 'camera pushes in', inputs: { source: { assetId: 'a' } }, params: { duration: 5 } }), m, h.context)
    expect((bodyOf(h.calls[0]!).input as { type: string }[]).map(p => p.type)).toEqual(['image', 'text'])
    await h.adapter.submit(req({ op: 'generate', prompt: 'forest to snow', inputs: { firstFrame: { assetId: 'a' }, lastFrame: { assetId: 'b' }, references: [{ assetId: 'c' }] }, params: { duration: 8 } }), m, h.context)
    expect((bodyOf(h.calls[1]!).input as { type: string }[]).map(p => p.type)).toEqual(['image', 'image', 'image', 'text'])
    expect(h.adapter.validate(req({ inputs: { firstFrame: { assetId: 'a' }, lastFrame: { assetId: 'b' } }, params: { duration: 12 } }), m)).toEqual([{ path: 'params.duration', message: 'First and last frame videos support 3 to 10 seconds' }])
    expect(h.adapter.validate(req({ inputs: { references: Array.from({ length: 7 }, (_, i) => ({ assetId: String(i) })) } }), m)[0]!.path).toBe('inputs')
  })

  it('edit and extend of a clip Gemini made use previous_interaction_id (no re-upload); an uploaded clip travels inline', async () => {
    const h = harness(() => new Response(fx('interaction-video-inline.json')))
    const m = await omni(h.adapter)
    h.recalled.set('vid1:interaction', 'v1_prev')
    await h.adapter.submit(req({ op: 'restyle', prompt: 'Make the violin invisible', inputs: { video: { assetId: 'vid1' } } }), m, h.context)
    expect(bodyOf(h.calls[0]!)).toMatchObject({ previous_interaction_id: 'v1_prev', input: 'Make the violin invisible' })
    await h.adapter.submit(req({ op: 'extend', inputs: { video: { assetId: 'vid1' } }, params: { duration: 5 } }), m, h.context)
    expect(bodyOf(h.calls[1]!)).toMatchObject({ previous_interaction_id: 'v1_prev', input: 'Continue the scene.' })
    expect(bodyOf(h.calls[1]!).response_format.duration).toBeUndefined()           // extension length is the model's choice
    await h.adapter.submit(req({ op: 'restyle', prompt: 'Make it rain', inputs: { video: { assetId: 'uploaded' } } }), m, h.context)
    const uploaded = bodyOf(h.calls[2]!)
    expect(uploaded.previous_interaction_id).toBeUndefined()
    expect((uploaded.input as { type: string }[]).map(p => p.type)).toEqual(['video', 'text'])
    expect(h.adapter.validate(req({ op: 'restyle', inputs: { video: { assetId: 'v' } } }), m)).toEqual([{ path: 'prompt', message: 'Describe the change to make' }])
    expect(h.adapter.validate(req({ op: 'extend', params: { duration: 12 }, inputs: { video: { assetId: 'v' } } }), m)[0]!.message).toMatch(/3 to 10 seconds/)
  })

  it('large outputs arrive as a Files-API uri: submit returns a remote handle, poll waits for ACTIVE, then downloads with the key header', async () => {
    const seq = [fx('file-processing.json'), fx('file-active.json')]
    const h = harness((url, init) => init.method === 'POST' ? new Response(fx('interaction-video-uri.json')) : new Response(seq.shift()!))
    const m = await omni(h.adapter)
    const sub = await h.adapter.submit(req({ prompt: 'a long cinematic shot', params: { duration: 15, resolution: '4k' } }), m, h.context)
    expect(sub).toEqual({ kind: 'remote', remote: { file: 'abc-123', interaction: 'v1_big456' }, pollAfterMs: 5000 })
    if (sub.kind !== 'remote') return
    expect(await h.adapter.poll(sub.remote, m, h.context)).toMatchObject({ state: 'running' })
    const done = await h.adapter.poll(sub.remote, m, h.context)
    expect(done).toMatchObject({ state: 'done' })
    if (done.state === 'done') expect(done.outputs[0]).toEqual({ url: 'https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media', headers: { 'x-goog-api-key': 'AIza-secret' }, mediaType: 'video/mp4', notes: { interaction: 'v1_big456' } })
    expect(h.calls.at(-1)!.url).toContain('/v1beta/files/abc-123')
    const failed = harness((_u, init) => init.method === 'POST' ? new Response(fx('interaction-video-uri.json')) : new Response(fx('file-failed.json')))
    expect(await failed.adapter.poll({ file: 'abc-123' }, m, failed.context)).toMatchObject({ state: 'failed', error: { kind: 'unknown' } })
    await expect(h.adapter.poll({ file: '../../etc' }, m, h.context)).rejects.toThrow(/Invalid Gemini file reference/)
  })

  it('a text-only answer becomes a moderation or invalid error with the model\'s words; estimates follow the resolution tier', async () => {
    const h = harness(() => new Response(fx('interaction-text-only.json')))
    const m = await omni(h.adapter)
    await expect(h.adapter.submit(req({ prompt: 'x' }), m, h.context)).rejects.toMatchObject({ kind: 'moderation', message: expect.stringContaining('safety policy') })
    expect(h.adapter.estimate(req({ params: { duration: 10, resolution: '360p' } }), m)).toEqual({ usd: 0.23 })
    expect(h.adapter.estimate(req({ params: { duration: 10, resolution: '4k' } }), m)).toEqual({ usd: 2.09 })
    expect(h.adapter.estimate(req({ op: 'extend', params: {} }), m)).toEqual({ usd: 0.7 })
  })

  it('refuses inputs over the inline size limit before any network call', async () => {
    const h = harness(() => new Response(fx('interaction-video-inline.json')))
    const big = { ...h.context, readInput: async () => ({ bytes: new Uint8Array(19 * 1024 * 1024), mediaType: 'video/mp4' }) }
    await expect(h.adapter.submit(req({ op: 'restyle', prompt: 'x', inputs: { video: { assetId: 'v' } } }), await omni(h.adapter), big)).rejects.toMatchObject({ kind: 'invalid', message: expect.stringContaining('18 MB') })
    expect(h.calls).toHaveLength(0)
  })
})

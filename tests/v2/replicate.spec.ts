import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AdapterError, type AdapterContext, type ModelDescriptor, type OperationRequest } from '../../src/v2/contracts.js'
import { ReplicateAdapter, REPLICATE_PRESETS } from '../../src/v2/providers/replicate.js'

const fx = (name: string): string => readFileSync(new URL(`./fixtures/replicate/${name}`, import.meta.url), 'utf8')
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
const BIG = new Uint8Array(300 * 1024).fill(7)

function harness(routes: (url: string, init: RequestInit) => Response, ...tokenArg: [] | [string | undefined]) {
  const token = tokenArg.length === 0 ? 'r8_secret' : tokenArg[0]
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return routes(String(url), init ?? {}) }) as typeof fetch
  const adapter = new ReplicateAdapter({ apiToken: async () => token, fetch: fetchFn, pinned: () => ['someone/custom-model', 'not a slug'] })
  const context = (bytes: Uint8Array = PNG): AdapterContext => ({ signal: new AbortController().signal, fetch: fetchFn, readInput: async () => ({ bytes, mediaType: 'image/png' }) })
  return { adapter, calls, context }
}
const req = (patch: Partial<OperationRequest>): OperationRequest => ({ op: 'generate', modelId: '', inputs: {}, params: {}, ...patch })
const find = async (a: ReplicateAdapter, id: string): Promise<ModelDescriptor> => (await a.listModels()).find(m => m.id === `replicate:${id}`)!

describe('Replicate catalog', () => {
  it('lists curated presets with capabilities, mask polarity and pinned community slugs (invalid slugs dropped)', async () => {
    const h = harness(() => new Response('{}'))
    const models = await h.adapter.listModels()
    expect(models.filter(m => m.curated).length).toBe(REPLICATE_PRESETS.length)
    expect((await find(h.adapter, 'black-forest-labs/flux-fill-pro'))).toMatchObject({ capabilities: ['inpaint'], maskPolarity: 'white-edit', inpaintMode: 'mask' })
    expect((await find(h.adapter, 'ideogram-ai/ideogram-4-5-precise-edit'))).toMatchObject({ maskPolarity: 'black-edit' })
    expect(models.find(m => m.id === 'replicate:someone/custom-model')).toMatchObject({ curated: false })
    expect(models.some(m => m.label === 'not a slug')).toBe(false)
    const caps = new Set(models.flatMap(m => m.capabilities))
    for (const c of ['t2i', 'i2i', 'inpaint', 'upscale-image', 't2v', 'i2v', 'v2v', 'extend', 'upscale-video', 'first-last-frame'] as const) expect(caps.has(c)).toBe(true)
  })
})

describe('Replicate predictions', () => {
  it('sync model: POSTs the official-model endpoint with Prefer: wait and Cancel-After, returns files with auth headers', async () => {
    const h = harness(() => new Response(fx('prediction-succeeded-image.json'), { status: 201 }))
    const up = await find(h.adapter, 'bria/increase-resolution')
    const result = await h.adapter.submit(req({ op: 'upscale', inputs: { source: { assetId: 'a' } }, params: { desired_increase: '4' } }), up, h.context())
    expect(result.kind).toBe('done')
    if (result.kind !== 'done') return
    expect(result.outputs).toEqual([{ url: 'https://replicate.delivery/xezq/abc/out.png', mediaType: 'image/png', headers: { authorization: 'Bearer r8_secret' } }])
    expect(result.cost).toEqual({ usd: 0.04, source: 'estimate' })
    const call = h.calls[0]!
    expect(call.url).toBe('https://api.replicate.com/v1/models/bria/increase-resolution/predictions')
    const headers = call.init.headers as Record<string, string>
    expect(headers).toMatchObject({ authorization: 'Bearer r8_secret', prefer: 'wait=55', 'cancel-after': '10m' })
    const body = JSON.parse(String(call.init.body)) as { input: Record<string, unknown> }
    expect(body.input.desired_increase).toBe(4)
    expect(String(body.input.image)).toMatch(/^data:image\/png;base64,/)
  })

  it('returns every file of a list output', async () => {
    const h = harness(() => new Response(fx('prediction-succeeded-list.json')))
    const flux = await find(h.adapter, 'black-forest-labs/flux-3-image')
    const r = await h.adapter.submit(req({ prompt: 'x', params: { aspect_ratio: '16:9' } }), flux, h.context())
    expect(r.kind === 'done' && r.outputs.map(o => o.url)).toEqual(['https://replicate.delivery/xezq/def/0.png', 'https://replicate.delivery/xezq/def/1.png'])
  })

  it('async video: no Prefer header, long Cancel-After, remote handle, then poll through processing to done', async () => {
    const seq = [fx('prediction-processing.json'), fx('prediction-succeeded-video.json')]
    const h = harness((url, init) => init.method === 'POST' ? new Response(fx('prediction-starting.json'), { status: 201 }) : new Response(seq.shift()!))
    const veo = await find(h.adapter, 'google/veo-3.1-fast')
    const sub = await h.adapter.submit(req({ op: 'animate', prompt: 'waves', inputs: { source: { assetId: 'a' } }, params: { duration: '4', resolution: '720p', aspect_ratio: '16:9', generate_audio: true } }), veo, h.context())
    expect(sub).toEqual({ kind: 'remote', remote: { id: 'gm3qorzdhgbfurvjtvhg6dckhu', getUrl: 'https://api.replicate.com/v1/predictions/gm3qorzdhgbfurvjtvhg6dckhu' }, pollAfterMs: 5000 })
    const headers = h.calls[0]!.init.headers as Record<string, string>
    expect(headers.prefer).toBeUndefined(); expect(headers['cancel-after']).toBe('30m')
    const body = JSON.parse(String(h.calls[0]!.init.body)) as { input: Record<string, unknown> }
    expect(body.input).toMatchObject({ prompt: 'waves', duration: 4, resolution: '720p', aspect_ratio: '16:9', generate_audio: true })
    expect(String(body.input.image)).toMatch(/^data:image\/png/)
    if (sub.kind !== 'remote') return
    expect(await h.adapter.poll(sub.remote, veo, h.context())).toMatchObject({ state: 'running', progress: 0.35 })
    const done = await h.adapter.poll(sub.remote, veo, h.context())
    expect(done).toMatchObject({ state: 'done', cost: { usd: 0.6, source: 'estimate' } })
    expect(done.state === 'done' && done.outputs[0]).toMatchObject({ mediaType: 'video/mp4', url: 'https://replicate.delivery/xezq/vid/out.mp4' })
  })

  it('classifies failures: sensitive content -> moderation, 401 -> auth, 429 -> retryable quota, canceled -> timeout', async () => {
    const h = harness(() => new Response(fx('prediction-failed.json')))
    const flux = await find(h.adapter, 'black-forest-labs/flux-3-image')
    await expect(h.adapter.submit(req({ prompt: 'x' }), flux, h.context())).rejects.toMatchObject({ kind: 'moderation' })
    const auth = harness(() => new Response('{"detail":"Invalid token"}', { status: 401 }))
    await expect(auth.adapter.submit(req({ prompt: 'x' }), flux, auth.context())).rejects.toMatchObject({ kind: 'auth', status: 401 })
    const rate = harness(() => new Response('{"detail":"throttled"}', { status: 429 }))
    await expect(rate.adapter.submit(req({ prompt: 'x' }), flux, rate.context())).rejects.toMatchObject({ kind: 'quota', retryable: true })
    const canceled = harness((url, init) => init.method === 'POST' ? new Response(fx('prediction-starting.json')) : new Response('{"id":"x","status":"canceled","error":"deadline"}'))
    const veo = await find(canceled.adapter, 'google/veo-3.1-fast')
    const sub = await canceled.adapter.submit(req({ prompt: 'x', params: { duration: '4' } }), veo, canceled.context())
    if (sub.kind === 'remote') expect(await canceled.adapter.poll(sub.remote, veo, canceled.context())).toMatchObject({ state: 'failed', error: { kind: 'timeout' } })
  })

  it('never leaks the token in errors and refuses foreign polling URLs', async () => {
    const h = harness(() => new Response('{"detail":"bad token r8_secret"}', { status: 401 }))
    const flux = await find(h.adapter, 'black-forest-labs/flux-3-image')
    const e = await h.adapter.submit(req({ prompt: 'x' }), flux, h.context()).catch((x: unknown) => x) as AdapterError
    expect(e.message).not.toContain('r8_secret')
    await expect(h.adapter.poll({ id: 'x', getUrl: 'https://evil.example/p' }, flux, h.context())).rejects.toThrow(/outside the Replicate API/)
    const none = harness(() => new Response('{}'), undefined)
    expect(await none.adapter.isConfigured()).toBe(false)
    await expect(none.adapter.submit(req({ prompt: 'x' }), flux, none.context())).rejects.toThrow(/REPLICATE_API_TOKEN/)
  })

  it('uploads inputs larger than 256 kB through /v1/files instead of data URIs', async () => {
    const h = harness((url, init) => url.endsWith('/files') ? new Response('{"urls":{"get":"https://api.replicate.com/v1/files/f1"}}', { status: 201 }) : new Response(fx('prediction-succeeded-image.json')))
    const up = await find(h.adapter, 'bria/increase-resolution')
    await h.adapter.submit(req({ op: 'upscale', inputs: { source: { assetId: 'a' } } }), up, h.context(BIG))
    expect(h.calls[0]!.url).toBe('https://api.replicate.com/v1/files')
    expect(h.calls[0]!.init.body).toBeInstanceOf(FormData)
    expect((JSON.parse(String(h.calls[1]!.init.body)) as { input: { image: string } }).input.image).toBe('https://api.replicate.com/v1/files/f1')
  })

  it('inpaint: validates inputs, then sends each model the mask in ITS polarity (fill-pro white=edit, Ideogram black=edit) at the source size', async () => {
    const sharp = (await import('sharp')).default
    const source = await sharp({ create: { width: 8, height: 4, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer()
    // Mask drawn at a DIFFERENT size (4x2) than the source: left half repaint. The host must resize it to 8x4.
    const drawn = await sharp(Buffer.from([255, 255, 0, 0, 255, 255, 0, 0]), { raw: { width: 4, height: 2, channels: 1 } }).png().toBuffer()
    const h = harness(() => new Response(fx('prediction-succeeded-image.json')))
    const read = async (ref: { assetId: string }) => ref.assetId === 's' ? { bytes: new Uint8Array(source), mediaType: 'image/png', width: 8, height: 4 } : { bytes: new Uint8Array(drawn), mediaType: 'image/png', width: 4, height: 2 }
    const context = { ...h.context(), readInput: read }
    const fill = await find(h.adapter, 'black-forest-labs/flux-fill-pro')
    expect(h.adapter.validate(req({ op: 'inpaint' }), fill).map(i => i.path)).toEqual(['inputs.source', 'inputs.mask'])
    const luma = async (dataUri: string): Promise<{ w: number; h: number; left: number; right: number }> => {
      const r = await sharp(Buffer.from(dataUri.split(',')[1]!, 'base64')).greyscale().raw().toBuffer({ resolveWithObject: true })
      return { w: r.info.width, h: r.info.height, left: r.data[0]!, right: r.data[r.info.width - 1]! }
    }
    const run = async (model: typeof fill, index: number): Promise<{ input: Record<string, string>; mask: Awaited<ReturnType<typeof luma>> }> => {
      await h.adapter.submit(req({ op: 'inpaint', prompt: 'add a boat', inputs: { source: { assetId: 's' }, mask: { assetId: 'm' } } }), model, context)
      const input = (JSON.parse(String(h.calls[index]!.init.body)) as { input: Record<string, string> }).input
      return { input, mask: await luma(input.mask!) }
    }
    const a = await run(fill, 0)
    expect(a.input).toMatchObject({ prompt: 'add a boat', steps: 50, guidance: 60 })
    expect(a.mask).toEqual({ w: 8, h: 4, left: 255, right: 0 })              // white = repaint, resized to the source size
    const ideo = await find(h.adapter, 'ideogram-ai/ideogram-4-5-precise-edit')
    const b = await run(ideo, 1)
    expect(b.mask).toEqual({ w: 8, h: 4, left: 0, right: 255 })              // inverted for black = edit
    expect(await luma(b.input.image!)).toMatchObject({ w: 8, h: 4 })
    const bria = await find(h.adapter, 'bria/genfill')
    expect((await run(bria, 2)).mask).toMatchObject({ left: 255, right: 0 })
  })

  it('inpaint refuses empty and full-frame masks before any network call', async () => {
    const sharp = (await import('sharp')).default
    const source = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
    const flat = (v: number): Promise<Buffer> => sharp(Buffer.alloc(16, v), { raw: { width: 4, height: 4, channels: 1 } }).png().toBuffer()
    const h = harness(() => new Response('{}'))
    const fill = await find(h.adapter, 'black-forest-labs/flux-fill-pro')
    for (const [value, message] of [[0, /selects nothing/], [255, /whole image/]] as const) {
      const mask = await flat(value)
      const context = { ...h.context(), readInput: async (ref: { assetId: string }) => ref.assetId === 's' ? { bytes: new Uint8Array(source), mediaType: 'image/png', width: 4, height: 4 } : { bytes: new Uint8Array(mask), mediaType: 'image/png', width: 4, height: 4 } }
      await expect(h.adapter.submit(req({ op: 'inpaint', inputs: { source: { assetId: 's' }, mask: { assetId: 'm' } } }), fill, context)).rejects.toMatchObject({ kind: 'invalid', message: expect.stringMatching(message) })
    }
    expect(h.calls).toHaveLength(0)
  })

  it('video operations map the right fields per model and validate the source video', async () => {
    const h = harness(() => new Response(fx('prediction-starting.json')))
    const edit = await find(h.adapter, 'wan-video/wan-2.7-videoedit')
    expect(h.adapter.validate(req({ op: 'restyle' }), edit)).toEqual([{ path: 'inputs.video', message: 'This operation needs a source video' }])
    await h.adapter.submit(req({ op: 'restyle', prompt: 'anime', inputs: { video: { assetId: 'v' }, references: [{ assetId: 'r' }] }, params: { resolution: '720p' } }), edit, h.context())
    expect((JSON.parse(String(h.calls[0]!.init.body)) as { input: Record<string, unknown> }).input).toMatchObject({ prompt: 'anime', resolution: '720p' })
    const ext = await find(h.adapter, 'xai/grok-imagine-video-extension')
    await h.adapter.submit(req({ op: 'extend', prompt: 'continue', inputs: { video: { assetId: 'v' } }, params: { duration: '5' } }), ext, h.context())
    expect((JSON.parse(String(h.calls[1]!.init.body)) as { input: Record<string, unknown> }).input).toMatchObject({ prompt: 'continue', duration: 5 })
    const top = await find(h.adapter, 'topazlabs/video-upscale')
    await h.adapter.submit(req({ op: 'upscale', inputs: { video: { assetId: 'v' } }, params: { target_resolution: '1080p', target_fps: 30 } }), top, h.context())
    expect((JSON.parse(String(h.calls[2]!.init.body)) as { input: Record<string, unknown> }).input).toMatchObject({ target_resolution: '1080p', target_fps: 30 })
  })

  it('cancel POSTs the prediction cancel endpoint', async () => {
    const h = harness(() => new Response('{}'))
    await h.adapter.cancel({ id: 'p9' }, h.context())
    expect(h.calls[0]).toMatchObject({ url: 'https://api.replicate.com/v1/predictions/p9/cancel' })
    expect(h.calls[0]!.init.method).toBe('POST')
  })
})

describe('Replicate examples', () => {
  it('maps author examples to links, drops inline data URIs and non-Replicate thumbnails, and reports unavailable without a token', async () => {
    const { fetchModelExamples } = await import('../../src/v2/providers/replicate.js')
    const f = (async () => new Response(fx('examples.json'))) as unknown as typeof fetch
    const got = await fetchModelExamples({ apiToken: async () => 'r8_secret', fetch: f }, 'black-forest-labs/flux-fill-pro')
    expect(got.available).toBe(true)
    expect(got.examples[0]).toEqual({ pageUrl: 'https://replicate.com/p/ex1', thumbUrl: 'https://replicate.delivery/xezq/ex1/out.png', summary: 'a cat on a sofa', input: { prompt: 'a cat on a sofa', steps: 50 } })
    expect(got.examples[1]).toMatchObject({ pageUrl: 'https://replicate.com/p/ex2', thumbUrl: 'https://replicate.delivery/xezq/ex2/0.png' })
    expect(await fetchModelExamples({ apiToken: async () => undefined, fetch: f }, 'a/b')).toEqual({ available: false, examples: [] })
    expect(await fetchModelExamples({ apiToken: async () => 'r8_secret', fetch: f }, '../../etc')).toEqual({ available: true, examples: [] })
  })
})

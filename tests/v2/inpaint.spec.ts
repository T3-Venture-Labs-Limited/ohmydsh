import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterContext, ModelDescriptor, OperationRequest, ProviderAdapter, SubmitResult } from '../../src/v2/contracts.js'
import { BlobStore } from '../../src/v2/assets/blobs.js'
import { StudioDb } from '../../src/v2/assets/db.js'
import { AssetService } from '../../src/v2/assets/service.js'
import { JobRunner } from '../../src/v2/jobs/runner.js'
import { ProviderRegistry } from '../../src/v2/providers/registry.js'
import { OpenRouterAdapter } from '../../src/v2/providers/openrouter.js'

const solid = (w: number, h: number, rgb: [number, number, number]): Promise<Buffer> => sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer()
const leftHalfMask = (w: number, h: number): Promise<Buffer> => sharp(Buffer.from(Array.from({ length: w * h }, (_, i) => (i % w < w / 2 ? 255 : 0))), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer()
const rgbAt = async (png: Uint8Array, x: number, y: number): Promise<number[]> => { const r = await sharp(png).raw().toBuffer({ resolveWithObject: true }); const i = (y * r.info.width + x) * r.info.channels; return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!] }
const decode = (dataUrl: string): Buffer => Buffer.from(dataUrl.split(',')[1]!, 'base64')

let dir: string; let db: StudioDb; let assets: AssetService
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'studio-inpaint-')); db = new StudioDb(join(dir, 's.db')); assets = new AssetService(db, new BlobStore(dir)) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

describe('OpenRouter inpaint modes', () => {
  const model = (patch: Partial<ModelDescriptor>): ModelDescriptor => ({ id: 'openrouter:m/x', provider: 'openrouter', remoteId: 'm/x', label: 'X', capabilities: ['inpaint'], inputs: { images: { max: 4, roles: ['ref', 'source'] } }, params: [], async: 'sync', curated: true, ...patch })
  async function run(patch: Partial<ModelDescriptor>): Promise<Record<string, unknown>> {
    const source = await solid(8, 4, [0, 200, 0]); const mask = await leftHalfMask(8, 4)
    let body: Record<string, unknown> = {}
    const fetchFn = (async (_u: string, init?: RequestInit) => { body = JSON.parse(String(init!.body)); return new Response(JSON.stringify({ data: [{ b64_json: source.toString('base64') }], usage: { cost: 0.1 } })) }) as unknown as typeof fetch
    const adapter = new OpenRouterAdapter({ apiKey: async () => 'k', fetch: fetchFn })
    const context: AdapterContext = { signal: new AbortController().signal, fetch: fetchFn, readInput: async ref => ref.assetId === 's' ? { bytes: new Uint8Array(source), mediaType: 'image/png', width: 8, height: 4 } : { bytes: new Uint8Array(mask), mediaType: 'image/png', width: 8, height: 4 } }
    await adapter.submit({ op: 'inpaint', modelId: 'openrouter:m/x', prompt: 'add a hat', inputs: { source: { assetId: 's' }, mask: { assetId: 'm' } }, params: {} }, model(patch), context)
    return body
  }

  it('markup mode sends a transparent PNG overlay of the source size, opaque only in the repaint area', async () => {
    const body = await run({ inpaintMode: 'markup' })
    const markup = body.markup as { image_url: { url: string } }
    const r = await sharp(decode(markup.image_url.url)).raw().toBuffer({ resolveWithObject: true })
    expect([r.info.width, r.info.height, r.info.channels]).toEqual([8, 4, 4])
    expect([r.data[3], r.data[7 * 4 + 3]]).toEqual([200, 0])
    expect(body.prompt).toBe('add a hat')
  })

  it('overlay-prompt mode replaces the first reference by a tinted copy and appends the instruction to the prompt', async () => {
    const body = await run({ inpaintMode: 'overlay-prompt' })
    expect(body.markup).toBeUndefined()
    expect(String(body.prompt)).toMatch(/^add a hat\n\nOnly change the area highlighted in magenta/)
    const refs = body.input_references as { image_url: { url: string } }[]
    const tinted = decode(refs[0]!.image_url.url)
    const [r, g] = await rgbAt(tinted, 0, 0); const keep = await rgbAt(tinted, 7, 0)
    expect(r!).toBeGreaterThan(100); expect(g!).toBeLessThan(200); expect(keep).toEqual([0, 200, 0])
  })
})

describe('runner composite-back for inpaint', () => {
  it('stores model output pasted over the original outside the mask (even when the model returned another size) and records composited', async () => {
    const source = await solid(8, 4, [0, 0, 255]); const mask = await leftHalfMask(8, 4)
    const src = await assets.ingestBytes(new Uint8Array(source), 'image/png', { source: 'import' })
    const msk = await assets.ingestBytes(new Uint8Array(mask), 'image/png', { source: 'derived', tags: ['mask'] })
    const redWholeFrame = await solid(16, 8, [255, 0, 0])
    const model: ModelDescriptor = { id: 'openrouter:fake/inp', provider: 'openrouter', remoteId: 'inp', label: 'Inp', capabilities: ['inpaint'], inputs: {}, params: [], inpaintMode: 'markup', async: 'sync', curated: true }
    const adapter: ProviderAdapter = { id: 'openrouter', isConfigured: async () => true, listModels: async () => [model], submit: async (): Promise<SubmitResult> => ({ kind: 'done', outputs: [{ bytes: new Uint8Array(redWholeFrame), mediaType: 'image/png' }] }) }
    const registry = new ProviderRegistry(); registry.register(adapter)
    const runner = new JobRunner(db, registry, assets, { sleep: async () => { await Promise.resolve() } })
    const job = await runner.submit({ op: 'inpaint', modelId: model.id, prompt: 'x', inputs: { source: { assetId: src.id }, mask: { assetId: msk.id } }, params: {} })
    const done = await runner.wait(job.id, 5000)
    expect(done.state).toBe('succeeded')
    const out = db.getAsset(done.assetIds[0]!)!
    expect([out.width, out.height]).toEqual([8, 4])
    expect(out.params).toMatchObject({ composited: true })
    const bytes = await assets.blobs.read(out.sha256, out.ext)
    expect(await rgbAt(bytes, 0, 0)).toEqual([255, 0, 0])     // inside the mask: the model's pixels
    expect(await rgbAt(bytes, 7, 3)).toEqual([0, 0, 255])     // outside the mask: the original, untouched
    expect(db.parents(out.id).map(e => e.role).sort()).toEqual(['mask', 'source'])
    await runner.dispose()
  })

  it('blends an outpaint seam across the overlap band (wide feather), but keeps plain inpaint edges tight', async () => {
    const wide = (rgb: [number, number, number]): Promise<Buffer> => sharp({ create: { width: 800, height: 400, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer()
    // Mask: repaint the right half (x >= 100). The "model" returns a LIGHTER tone for the whole frame.
    const mask = await sharp(Buffer.from(Array.from({ length: 800 * 400 }, (_, i) => (i % 800 >= 400 ? 255 : 0))), { raw: { width: 800, height: 400, channels: 1 } }).png().toBuffer()
    const run = async (tags: string[]): Promise<{ at: (x: number) => number }> => {
      const src = await assets.ingestBytes(new Uint8Array(await wide([100, 100, 100])), 'image/png', { source: 'import', tags })
      const msk = await assets.ingestBytes(new Uint8Array(mask), 'image/png', { source: 'derived', tags: ['mask'] })
      const lighter = await wide([200, 200, 200])
      const model: ModelDescriptor = { id: 'openrouter:fake/seam', provider: 'openrouter', remoteId: 'seam', label: 'Seam', capabilities: ['inpaint'], inputs: {}, params: [], async: 'sync', curated: true }
      const adapter: ProviderAdapter = { id: 'openrouter', isConfigured: async () => true, listModels: async () => [model], submit: async (): Promise<SubmitResult> => ({ kind: 'done', outputs: [{ bytes: new Uint8Array(lighter), mediaType: 'image/png' }] }) }
      const registry = new ProviderRegistry(); registry.register(adapter)
      const runner = new JobRunner(db, registry, assets, { sleep: async () => { await Promise.resolve() } })
      const job = await runner.wait((await runner.submit({ op: 'inpaint', modelId: model.id, inputs: { source: { assetId: src.id }, mask: { assetId: msk.id } }, params: {} })).id, 5000)
      const out = db.getAsset(job.assetIds[0]!)!
      const raw = await sharp(await assets.blobs.read(out.sha256, out.ext)).raw().toBuffer({ resolveWithObject: true })
      await runner.dispose()
      return { at: x => raw.data[(200 * 800 + x) * raw.info.channels]! }
    }
    const plain = await run([]); const outpaint = await run(['outpaint'])
    // Plain inpaint: the tone jumps within a couple of pixels of the mask edge.
    expect(plain.at(396)).toBe(100); expect(plain.at(403)).toBeGreaterThan(190)
    // Outpaint: a smooth ramp reaches into both sides and no step between neighbours is large.
    expect(outpaint.at(392)).toBeGreaterThan(100); expect(outpaint.at(408)).toBeLessThan(200)
    let maxStep = 0; for (let x = 340; x < 460; x++) maxStep = Math.max(maxStep, Math.abs(outpaint.at(x + 1) - outpaint.at(x)))
    expect(maxStep).toBeLessThan(15)
    expect(outpaint.at(5)).toBe(100)                           // far from the seam the original is still bit-exact
  })

  it('falls back to the raw model output when compositing is impossible', async () => {
    const src = await assets.ingestBytes(new Uint8Array(await solid(4, 4, [0, 0, 255])), 'image/png', { source: 'import' })
    // Declared PNG with a valid signature but a truncated body: it stores (type sniffed) yet sharp cannot decode it.
    const truncated = new Uint8Array((await solid(4, 4, [9, 9, 9])).subarray(0, 40))
    const garbage = await assets.ingestBytes(truncated, 'image/png', { source: 'import' })
    const warnings: string[] = []
    const model: ModelDescriptor = { id: 'openrouter:fake/inp2', provider: 'openrouter', remoteId: 'inp2', label: 'Inp2', capabilities: ['inpaint'], inputs: {}, params: [], async: 'sync', curated: true }
    const raw = await solid(4, 4, [1, 2, 3])
    const adapter: ProviderAdapter = { id: 'openrouter', isConfigured: async () => true, listModels: async () => [model], submit: async () => ({ kind: 'done', outputs: [{ bytes: new Uint8Array(raw), mediaType: 'image/png' }] }) as SubmitResult }
    const registry = new ProviderRegistry(); registry.register(adapter)
    const runner = new JobRunner(db, registry, assets, { logger: { warn: m => { warnings.push(m) } } })
    // The adapter (fake) ignores the mask; the runner's composite step cannot read it and must not fail the job.
    const done = await (async () => { const j = await runner.submit({ op: 'inpaint', modelId: model.id, prompt: 'x', inputs: { source: { assetId: src.id }, mask: { assetId: garbage.id } }, params: {} }); return runner.wait(j.id, 5000) })()
    expect(done.state).toBe('succeeded')
    const out = db.getAsset(done.assetIds[0]!)!
    expect(out.params).not.toHaveProperty('composited')
    expect(warnings.some(w => /composite-back skipped/.test(w))).toBe(true)
    expect(await rgbAt(await assets.blobs.read(out.sha256, out.ext), 0, 0)).toEqual([1, 2, 3])   // the model's own output, stored as-is
    await runner.dispose()
  })
})

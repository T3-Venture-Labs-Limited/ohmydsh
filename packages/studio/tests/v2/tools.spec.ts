import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelDescriptor, ProviderAdapter, SubmitResult } from '../../src/v2/contracts.js'
import { createCore, type StudioCore } from '../../src/v2/core.js'
import { registerV2Tools } from '../../src/v2/tools/tools.js'

type Tool = { name: string; execute(args: Record<string, unknown>, exec: unknown): Promise<{ text: string; assetIds?: string[]; jobId?: string; state?: string }> }
const exec = { signal: new AbortController().signal, agent: undefined }

let dir: string; let core: StudioCore; const tools = new Map<string, Tool>(); let seen: { modelId: string; prompt?: string; refs?: number; source?: boolean }[] = []
let envExtra: Record<string, unknown> = {}
const inpaintModel: ModelDescriptor = { id: 'openrouter:t/inp', provider: 'openrouter', remoteId: 'inp', label: 'Inp', capabilities: ['inpaint'], inputs: {}, params: [], async: 'sync', curated: true, tier: 'quality' }
const otherModel: ModelDescriptor = { id: 'replicate:t/other', provider: 'replicate', remoteId: 'other', label: 'Other', capabilities: ['t2i', 'i2i'], inputs: { images: { max: 4, roles: ['ref', 'source'] } }, params: [], async: 'sync', curated: true, tier: 'quality' }
const imageModel: ModelDescriptor = { id: 'openrouter:t/img', provider: 'openrouter', remoteId: 'img', label: 'Img', capabilities: ['t2i'], inputs: {}, params: [{ key: 'aspect_ratio', label: 'Aspect', type: 'enum', values: ['1:1', '16:9'], default: '1:1' }], async: 'sync', curated: true, tier: 'value', pricing: { unit: 'image', usd: 0.03 } }
const solid = (w: number, h: number): Promise<Buffer> => sharp({ create: { width: w, height: h, channels: 3, background: { r: 5, g: 80, b: 160 } } }).png().toBuffer()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-tools-')); core = createCore({ root: dir, runner: { sleep: async () => { await Promise.resolve() } } })
  seen = []; tools.clear(); envExtra = {}
  const adapter: ProviderAdapter = { id: 'openrouter', isConfigured: async () => true, listModels: async () => [inpaintModel, imageModel],
    submit: async (r, m): Promise<SubmitResult> => { seen.push({ modelId: m.id, ...(r.prompt === undefined ? {} : { prompt: r.prompt }), refs: r.inputs.references?.length ?? 0, source: r.inputs.source !== undefined }); const w = r.op === 'inpaint' ? 30 : 8; return { kind: 'done', outputs: [{ bytes: new Uint8Array(await solid(w, r.op === 'inpaint' ? 16 : 8)), mediaType: 'image/png' }], cost: { usd: 0.03, source: 'provider' } } } }
  core.registry.register(adapter)
  core.registry.register({ id: 'replicate', isConfigured: async () => true, listModels: async () => [otherModel], submit: adapter.submit } as ProviderAdapter)
  const ctx = { tools: { register: (t: Tool) => { tools.set(t.name, t) } }, get: () => undefined }
  registerV2Tools({ ctx: ctx as never, core, sessionOf: () => 'sess-1', get resolveReferences() { return envExtra.resolveReferences as never }, get defaultProvider() { return envExtra.defaultProvider as never }, get saveToWorkspace() { return envExtra.saveToWorkspace as never }, attachImage: async a => ({ attachmentId: `att-${a.id}`, mediaType: 'image/png', bytes: a.bytes, width: a.width ?? 1, height: a.height ?? 1 }) as never })
})
afterEach(async () => { await core.close(); await rm(dir, { recursive: true, force: true }) })
const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, exec)

describe('studio tools', () => {
  it('registers the four v2 tools', () => { expect([...tools.keys()].sort()).toEqual(['studio_gallery', 'studio_job', 'studio_make', 'studio_models']) })

  it('studio_make generates with the picked model, records the session and reports cost; studio_gallery finds it', async () => {
    envExtra.defaultProvider = () => 'openrouter'
    const r = await call('studio_make', { op: 'generate', prompt: 'a red kite', tags: ['kite'] })
    expect(r.state).toBe('succeeded'); expect(r.text).toMatch(/Job job_\w+ started on Img/); expect(r.text).toMatch(/cost \$0\.03/)
    const asset = core.db.getAsset(r.assetIds![0]!)!
    expect(asset).toMatchObject({ prompt: 'a red kite', sessionId: 'sess-1', tags: ['kite'] })
    const g = await call('studio_gallery', { query: 'kite' })
    expect(g.text).toMatch(/1 match/); expect(g.assetIds).toEqual([asset.id])
    expect((await call('studio_gallery', { asset: asset.id })).text).toMatch(/prompt: a red kite/)
  })

  it('studio_make with expand prepares the canvas + mask and runs an inpaint (outpaint) on the pair', async () => {
    const src = await core.assets.ingestBytes(new Uint8Array(await solid(20, 10)), 'image/png', { source: 'import', title: 'Pier' })
    const r = await call('studio_make', { op: 'inpaint', source: src.id, prompt: 'continue the pier', expand: { right: 10, bottom: 6 } })
    expect(r.state).toBe('succeeded')
    expect(seen).toEqual([{ modelId: 'openrouter:t/inp', prompt: 'continue the pier', refs: 0, source: true }])
    const out = core.db.getAsset(r.assetIds![0]!)!
    expect([out.width, out.height]).toEqual([30, 16])
    expect(core.db.parents(out.id).map(e => e.role).sort()).toEqual(['mask', 'source'])
    expect(core.db.queryAssets({ tag: 'outpaint' }).total).toBe(1)
    await expect(call('studio_make', { op: 'inpaint', source: 'ZZZZZZZZZZZZZZZZ', expand: { right: 5 } })).rejects.toThrow(/expand needs source/)
    await expect(call('studio_make', { op: 'inpaint', source: src.id, expand: {} })).rejects.toThrow(/at least one side/)
  })

  it('resolves conversation attachments: the first becomes the source of an edit, all become references for a generate', async () => {
    const files = [await solid(8, 8), await solid(6, 6)].map(b => ({ data: new Uint8Array(b), mediaType: 'image/png' }))
    const calls: unknown[] = []
    envExtra.resolveReferences = async (sel: unknown) => { calls.push(sel); return files }
    const edit = await call('studio_make', { op: 'edit', prompt: 'merge them', source_attachment_ids: ['a1', 'a2'], model: 'replicate:t/other' })
    expect(edit.state).toBe('succeeded'); expect(seen.at(-1)).toMatchObject({ modelId: 'replicate:t/other', refs: 1, source: true })
    expect(calls[0]).toEqual({ source_attachment_ids: ['a1', 'a2'] })
    const stored = core.db.queryAssets({ tag: 'reference' }); expect(stored.total).toBe(2)
    expect(core.db.parents(edit.assetIds![0]!).map(e => e.role).sort()).toEqual(['reference', 'source'])
    await call('studio_make', { op: 'generate', prompt: 'in this style', source_path: 'refs/style.png', model: 'replicate:t/other' })
    expect(seen.at(-1)).toMatchObject({ refs: 2, source: false })
    envExtra.resolveReferences = undefined
    await expect(call('studio_make', { op: 'edit', prompt: 'x', source_attachment_id: 'a1' })).rejects.toThrow(/not available in this session/)
  })

  it('an edit with no explicit source uses the newest conversation image, but only when asked to edit', async () => {
    const calls: unknown[] = []
    envExtra.resolveReferences = async (sel: unknown) => { calls.push(sel); return [{ data: new Uint8Array(await solid(8, 8)), mediaType: 'image/png' }] }
    const r = await call('studio_make', { op: 'edit', prompt: 'make the sail blue', model: 'replicate:t/other' })
    expect(r.state).toBe('succeeded'); expect(calls).toEqual([{}]); expect(seen.at(-1)).toMatchObject({ source: true })
    await call('studio_make', { op: 'generate', prompt: 'a boat', model: 'replicate:t/other' })
    expect(calls).toHaveLength(1)                                   // generate never reaches for conversation images on its own
    const asset = core.db.queryAssets({ tag: 'reference' }); expect(asset.total).toBe(1)
  })

  it('batch prompts run in order with one result each, report per-item failures and enforce the 10 limit', async () => {
    const r = await call('studio_make', { op: 'generate', prompts: ['a cat', 'a dog', 'a fox'], model: 'openrouter:t/img' })
    expect(r.text).toMatch(/^Batch: 3 of 3 succeeded\./); expect(r.assetIds).toHaveLength(3)
    expect(seen.map(x => x.prompt)).toEqual(['a cat', 'a dog', 'a fox'])
    const partial = await call('studio_make', { op: 'generate', prompts: ['ok one', 'bad', 'ok two'], model: 'openrouter:t/img', params: { aspect_ratio: '1:1' } , })
    expect(partial.state).toBe('succeeded')
    await expect(call('studio_make', { op: 'generate', prompts: Array.from({ length: 11 }, (_, i) => `p${String(i)}`) })).rejects.toThrow(/at most 10 prompts/)
    await expect(call('studio_make', { op: 'generate', prompts: ['', '  '] })).rejects.toThrow(/at least one non-empty prompt/)
  })

  it('provider restriction and the configured default provider steer the automatic model choice', async () => {
    await call('studio_make', { op: 'generate', prompt: 'x', provider: 'replicate' })
    expect(seen.at(-1)!.modelId).toBe('replicate:t/other')
    await expect(call('studio_make', { op: 'inpaint', prompt: 'x', source: 'ABCDEFGH12345678', mask: 'ABCDEFGH12345679', provider: 'replicate' })).rejects.toThrow(/on provider replicate/)
    envExtra.defaultProvider = () => 'replicate'
    await call('studio_make', { op: 'generate', prompt: 'y' })
    expect(seen.at(-1)!.modelId).toBe('replicate:t/other')
    envExtra.defaultProvider = () => 'openrouter'
    await call('studio_make', { op: 'generate', prompt: 'z' })
    expect(seen.at(-1)!.modelId).toBe('openrouter:t/img')
    envExtra.defaultProvider = () => 'grok-sub'          // not configured / no suitable model: falls back to the best available
    await call('studio_make', { op: 'generate', prompt: 'w' })
    expect(['openrouter:t/img', 'replicate:t/other']).toContain(seen.at(-1)!.modelId)
  })

  it('saves attached images into the workspace when enabled, records the path on the asset and survives a failing save', async () => {
    envExtra.saveToWorkspace = async (_ref: unknown, bytes: Uint8Array) => { expect(bytes.byteLength).toBeGreaterThan(0); return { path: 'studio/out.png' } }
    const ok = await call('studio_make', { op: 'generate', prompt: 'saved one', model: 'openrouter:t/img' })
    expect(ok.text).toMatch(/and to the workspace at "studio\/out\.png"/)
    expect(core.db.getAsset(ok.assetIds![0]!)!.workspacePath).toBe('studio/out.png')
    envExtra.saveToWorkspace = async () => { throw new Error('disk full') }
    const bad = await call('studio_make', { op: 'generate', prompt: 'unsaved', model: 'openrouter:t/img' })
    expect(bad.state).toBe('succeeded'); expect(bad.text).toMatch(/Saving to the workspace failed: disk full/)
    envExtra.saveToWorkspace = async () => ({})
    expect((await call('studio_make', { op: 'generate', prompt: 'quiet', model: 'openrouter:t/img' })).text).not.toMatch(/workspace/)
  })

  it('studio_make explains what is missing instead of failing opaquely', async () => {
    await expect(call('studio_make', { op: 'upscale', source: 'ABCDEFGH12345678' })).rejects.toThrow(/No configured model can do "upscale"/)
    await expect(call('studio_make', { op: 'generate', model: 'nonsense', prompt: 'x' })).rejects.toThrow(/modelId/)
  })

  it('studio_models lists configured models with parameters and prices; studio_job lists and validates ids', async () => {
    const m = await call('studio_models', { capability: 't2i' })
    expect(m.text).toMatch(/openrouter:t\/img — Img \[t2i\] ~\$0\.03\/image/); expect(m.text).toMatch(/aspect_ratio=1:1\|16:9/); expect(m.text).not.toMatch(/openrouter:t\/inp/)
    expect((await call('studio_job', {})).text).toBe('No Studio jobs yet.')
    await expect(call('studio_job', { id: '../../etc' })).rejects.toThrow(/Invalid job id/)
    await expect(call('studio_job', { id: 'job_NOPE' })).rejects.toThrow(/Unknown job/)
  })
})

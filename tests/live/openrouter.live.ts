/**
 * LIVE tests (real money). Run only on purpose:  LIVE_OPENROUTER=1 OPENROUTER_API_KEY=… npx vitest run --config vitest.live.config.ts
 * Each step is the cheapest model that exercises the path. Spend is read from the account's own usage counter.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCore, type StudioCore } from '../../src/v2/core.js'
import { OpenRouterAdapter } from '../../src/v2/providers/openrouter.js'

const KEY = process.env.OPENROUTER_API_KEY
const enabled = process.env.LIVE_OPENROUTER === '1' && KEY !== undefined
const MAX_USD = Number(process.env.LIVE_MAX_USD ?? '0.60')

async function usage(): Promise<number> {
  const r = await fetch('https://openrouter.ai/api/v1/credits', { headers: { authorization: `Bearer ${KEY!}` } })
  return ((await r.json()) as { data: { total_usage: number } }).data.total_usage
}

describe.skipIf(!enabled)('OpenRouter live', () => {
  let core: StudioCore; let dir: string; let before = 0
  const report: Record<string, unknown> = {}
  beforeAll(async () => {
    // Persistent so a paid source clip is reused across runs (ignored by git: .tmp/).
    dir = join(process.cwd(), '.tmp', 'live-core'); await mkdir(dir, { recursive: true })
    core = createCore({ root: dir })
    core.registry.register(new OpenRouterAdapter({ apiKey: async () => KEY, cache: { get: k => core.db.getCache(k), put: (k, p, t) => { core.db.putCache(k, p, t) } } }))
    before = await usage()
  })
  afterAll(async () => {
    const after = await usage()
    report.accountDeltaUsd = Math.round((after - before) * 10_000) / 10_000
    report.recordedCostUsd = core.db.spend().reduce((s, r) => s + r.usd, 0)
    console.log('LIVE REPORT', JSON.stringify(report))
    await writeFile(join(process.cwd(), '.tmp', 'live-report.json'), JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2))
    await core.close()
  })

  it('catalog lists live models and every curated entry we ship still exists upstream', async () => {
    const models = await core.registry.listModels({ refresh: true })
    expect(models.length).toBeGreaterThan(60)
    const upstream = new Set(models.filter(m => !m.curated || m.verifiedAt !== '2026-11-13').map(m => m.id))
    const curatedImages = models.filter(m => m.curated && m.async === 'sync')
    report.catalog = { total: models.length, curatedImages: curatedImages.length, videos: models.filter(m => m.async === 'job').length, discoveredFlag: upstream.size }
  })

  it('image: generates with the cheapest curated model, stores it content-addressed with real dimensions, cost and lineage-ready metadata', async () => {
    const job = await core.runner.submit({ op: 'generate', modelId: 'openrouter:qwen/qwen-image-3', prompt: 'a small red paper boat on calm blue water, soft morning light', inputs: {}, params: { aspect_ratio: '1:1', resolution: '1K', n: 1 }, tags: ['live-test'] })
    const done = await core.runner.wait(job.id, 180_000)
    report.image = { state: done.state, error: done.error, estimateUsd: done.estimateUsd, costUsd: done.costUsd, costSource: done.costSource, ms: (done.finishedAt ?? 0) - done.createdAt }
    expect(done.error).toBeUndefined(); expect(done.state).toBe('succeeded')
    const asset = core.db.getAsset(done.assetIds[0]!)!
    expect(asset).toMatchObject({ kind: 'image', source: 'generated', modelId: 'openrouter:qwen/qwen-image-3' })
    expect(asset.width).toBeGreaterThan(256); expect(asset.bytes).toBeGreaterThan(5_000)
    report.imageAsset = { id: asset.id, mime: asset.mime, w: asset.width, h: asset.height, bytes: asset.bytes }
  }, 200_000)

  it('image edit: reference-image edit through the same adapter keeps lineage to the source', async () => {
    const source = core.db.queryAssets({ tag: 'live-test' }).items[0]
    expect(source).toBeDefined()
    const job = await core.runner.submit({ op: 'edit', modelId: 'openrouter:qwen/qwen-image-3', prompt: 'make the boat blue', inputs: { source: { assetId: source!.id } }, params: { aspect_ratio: '1:1', resolution: '1K' } })
    const done = await core.runner.wait(job.id, 180_000)
    report.edit = { state: done.state, error: done.error, costUsd: done.costUsd }
    if (done.state === 'succeeded') expect(core.db.parents(done.assetIds[0]!)).toEqual([expect.objectContaining({ parentId: source!.id, role: 'source' })])
    else expect(['failed', 'needs_attention']).toContain(done.state)
  }, 200_000)

  it('video: cheapest t2v (Wan, 480p, 2 s) polls to completion, downloads with the bearer token, probes with ffprobe and makes a poster', async () => {
    const wan = (await core.registry.listModels()).find(m => m.id === 'openrouter:alibaba/wan-3.0')!
    const duration = wan.params.find(p => p.key === 'duration')
    expect(duration?.type).toBe('enum')
    const job = await core.runner.submit({ op: 'generate', modelId: wan.id, prompt: 'a red paper boat drifting on calm water', inputs: {}, params: { duration: '2', resolution: '480p', aspect_ratio: '16:9', generate_audio: false } })
    expect(job.estimateUsd).toBeCloseTo(0.1, 2)
    const done = await core.runner.wait(job.id, 12 * 60_000)
    report.video = { state: done.state, error: done.error, estimateUsd: job.estimateUsd, costUsd: done.costUsd, costSource: done.costSource, seconds: Math.round(((done.finishedAt ?? 0) - done.createdAt) / 1000) }
    expect(done.error).toBeUndefined(); expect(done.state).toBe('succeeded')
    const asset = core.db.getAsset(done.assetIds[0]!)!
    expect(asset.kind).toBe('video'); expect(asset.durationMs).toBeGreaterThan(1000); expect(asset.width).toBeGreaterThan(300); expect(asset.posterSha).toBeDefined()
    report.videoAsset = { id: asset.id, mime: asset.mime, w: asset.width, h: asset.height, durationMs: asset.durationMs, fps: asset.fps, codec: asset.codec, hasAudio: asset.hasAudio, bytes: asset.bytes }
    expect(core.db.getCache('openrouter:videos')).toBeDefined()
  }, 13 * 60_000)

  it('video upscale: FLUX Video Upscale on the clip from the previous step, recorded as an upscale-of lineage edge', async () => {
    let clip = core.db.queryAssets({ kind: 'video' }).items[0]
    if (clip === undefined) {
      // Cheapest possible source clip: 2 s, 480p, no audio request.
      const gen = await core.runner.submit({ op: 'generate', modelId: 'openrouter:alibaba/wan-3.0', prompt: 'a red paper boat drifting on calm water', inputs: {}, params: { duration: '2', resolution: '480p', aspect_ratio: '16:9' } })
      const g = await core.runner.wait(gen.id, 12 * 60_000)
      expect(g.state).toBe('succeeded')
      report.upscaleSourceCostUsd = g.costUsd
      clip = core.db.getAsset(g.assetIds[0]!)!
    }
    const up = (await core.registry.listModels()).find(m => m.id === 'openrouter:black-forest-labs/flux-video-upscale')!
    const job = await core.runner.submit({ op: 'upscale', modelId: up.id, inputs: { video: { assetId: clip.id } }, params: { upscale_factor: 1.5, creativity: 0 } })
    const done = await core.runner.wait(job.id, 12 * 60_000)
    report.videoUpscale = { state: done.state, error: done.error, costUsd: done.costUsd, costSource: done.costSource }
    if (done.state === 'succeeded') {
      const out = core.db.getAsset(done.assetIds[0]!)!
      expect(out.width!).toBeGreaterThan(clip.width!)
      expect(core.db.parents(out.id)).toEqual([expect.objectContaining({ parentId: clip.id, role: 'upscale-of' })])
    }
  }, 13 * 60_000)

  it('spend stayed under the cap', async () => {
    const delta = (await usage()) - before
    report.runningDeltaUsd = Math.round(delta * 10_000) / 10_000
    expect(delta).toBeLessThan(MAX_USD)
  })
})

describe.skipIf(!enabled)('OpenRouter live resume', () => {
  it('resumes a persisted remote job after a restart: polls the stored handle, downloads and records lineage without resubmitting', async () => {
    const dir = join(process.cwd(), '.tmp', 'live-core')
    const core = createCore({ root: dir })
    core.registry.register(new OpenRouterAdapter({ apiKey: async () => KEY, cache: { get: k => core.db.getCache(k), put: (k, p, t) => { core.db.putCache(k, p, t) } } }))
    const pending = core.db.listJobs({ states: ['running'] }).find(j => j.modelId.includes('upscale'))
    if (pending === undefined) { await core.close(); return }
    const before = await usage()
    const result = await core.runner.resume()
    expect(result.resumed).toContain(pending.id)
    const done = await core.runner.wait(pending.id, 15 * 60_000)
    const out = { state: done.state, error: done.error, costUsd: done.costUsd, costSource: done.costSource, accountDeltaUsd: Math.round(((await usage()) - before) * 10_000) / 10_000 }
    console.log('RESUME REPORT', JSON.stringify(out))
    await writeFile(join(process.cwd(), '.tmp', 'live-resume-report.json'), JSON.stringify(out, null, 2))
    if (done.state === 'succeeded') {
      const asset = core.db.getAsset(done.assetIds[0]!)!
      const parent = core.db.parents(asset.id)[0]!
      expect(parent.role).toBe('upscale-of')
      out satisfies object
    }
    await core.close()
  }, 16 * 60_000)
})

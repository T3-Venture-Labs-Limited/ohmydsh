import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdapterError, type ModelDescriptor, type OperationRequest, type ProviderAdapter, type SubmitResult, type PollResult, type JobRecord } from '../../src/v2/contracts.js'
import { BlobStore } from '../../src/v2/assets/blobs.js'
import { StudioDb } from '../../src/v2/assets/db.js'
import { AssetService } from '../../src/v2/assets/service.js'
import { ProviderRegistry } from '../../src/v2/providers/registry.js'
import { JobRunner } from '../../src/v2/jobs/runner.js'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

const imageModel: ModelDescriptor = {
  id: 'openrouter:fake/img', provider: 'openrouter', remoteId: 'img', label: 'Fake image', capabilities: ['t2i', 'i2i'], inputs: { images: { max: 4, roles: ['ref'] } },
  params: [{ key: 'aspect_ratio', label: 'Aspect ratio', type: 'enum', values: ['1:1', '16:9'], default: '1:1' }], async: 'sync', curated: true, pricing: { unit: 'image', usd: 0.04 },
}
const videoModel: ModelDescriptor = {
  id: 'openrouter:fake/vid', provider: 'openrouter', remoteId: 'vid', label: 'Fake video', capabilities: ['t2v'], inputs: {},
  params: [{ key: 'duration', label: 'Duration', type: 'integer', min: 1, max: 10, default: 4 }], async: 'job', curated: true, pricing: { unit: 'second', usd: 0.1 },
}

class FakeAdapter implements ProviderAdapter {
  readonly id = 'openrouter' as const
  configured = true
  submits: OperationRequest[] = []
  polls = 0
  canceled: unknown[] = []
  submitImpl: (request: OperationRequest, model: ModelDescriptor) => Promise<SubmitResult> = async (_r, model) => model.id === 'openrouter:fake/vid'
    ? { kind: 'remote', remote: { id: 'r1' }, pollAfterMs: 10 } : { kind: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }], cost: { usd: 0.05, source: 'provider' } }
  pollImpl: () => Promise<PollResult> = async () => ({ state: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }] })
  async isConfigured(): Promise<boolean> { return this.configured }
  async listModels(): Promise<readonly ModelDescriptor[]> { return [imageModel, videoModel] }
  async submit(request: OperationRequest, model: ModelDescriptor): Promise<SubmitResult> { this.submits.push(request); return this.submitImpl(request, model) }
  async poll(): Promise<PollResult> { this.polls++; return this.pollImpl() }
  async cancel(remote: Readonly<Record<string, unknown>>): Promise<void> { this.canceled.push(remote) }
}

let dir: string; let db: StudioDb; let adapter: FakeAdapter; let runner: JobRunner; let assets: AssetService
const request = (patch: Partial<OperationRequest> = {}): OperationRequest => ({ op: 'generate', modelId: 'openrouter:fake/img', prompt: 'a boat', inputs: {}, params: {}, ...patch })
const instantSleep = async (): Promise<void> => { await Promise.resolve() }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'studio-runner-'))
  db = new StudioDb(join(dir, 'studio.db'))
  assets = new AssetService(db, new BlobStore(dir))
  adapter = new FakeAdapter()
  const registry = new ProviderRegistry(); registry.register(adapter)
  runner = new JobRunner(db, registry, assets, { sleep: instantSleep, backoffMs: 1 })
})
afterEach(async () => { await runner.dispose(); db.close(); await rm(dir, { recursive: true, force: true }) })

describe('job runner', () => {
  it('runs a sync image job to success, stores the asset with lineage-ready metadata and records cost', async () => {
    const queued = await runner.submit(request({ params: { aspect_ratio: '16:9' } }))
    expect(queued.state).toBe('queued')
    expect(queued.estimateUsd).toBe(0.04)
    const done = await runner.wait(queued.id, 5000)
    expect(done.state).toBe('succeeded')
    expect(done.costUsd).toBe(0.05); expect(done.costSource).toBe('provider')
    const asset = db.getAsset(done.assetIds[0]!)!
    expect(asset).toMatchObject({ kind: 'image', modelId: 'openrouter:fake/img', prompt: 'a boat', costUsd: 0.05, jobId: queued.id, source: 'generated' })
    expect(asset.params).toEqual({ aspect_ratio: '16:9' })
  })

  it('validates params and capability before any spend', async () => {
    await expect(runner.submit(request({ params: { aspect_ratio: '3:1' } }))).rejects.toThrow(/Aspect ratio must be one of/)
    await expect(runner.submit(request({ params: { bogus: 1 } }))).rejects.toThrow(/Unknown parameter/)
    await expect(runner.submit(request({ op: 'inpaint' }))).rejects.toThrow(/cannot do inpaint/)
    await expect(runner.submit(request({ modelId: 'openrouter:fake/nope' }))).rejects.toThrow(/Unknown model/)
    adapter.configured = false
    await expect(runner.submit(request())).rejects.toThrow(/not configured/)
    expect(adapter.submits).toHaveLength(0)
  })

  it('polls an async video job, reports progress and downloads on completion', async () => {
    let n = 0
    adapter.pollImpl = async () => (++n < 3 ? { state: 'running', progress: n / 3, message: `step ${n}` } : { state: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }], cost: { usd: 0.4, source: 'provider' } })
    const seen: string[] = []
    runner.onJob(j => seen.push(j.state))
    const job = await runner.submit(request({ modelId: 'openrouter:fake/vid', params: { duration: 4 } }))
    expect(job.estimateUsd).toBe(0.4)
    const done = await runner.wait(job.id, 5000)
    expect(done.state).toBe('succeeded'); expect(adapter.polls).toBe(3)
    expect(seen).toContain('submitting'); expect(seen).toContain('running'); expect(seen).toContain('finalizing')
    expect(db.getJob(job.id)!.remote).toEqual({ id: 'r1' })
  })

  it('persists "submitting" before the provider is called', async () => {
    let stateDuringSubmit: string | undefined
    adapter.submitImpl = async () => { stateDuringSubmit = db.listJobs()[0]!.state; return { kind: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }] } }
    const job = await runner.submit(request()); await runner.wait(job.id, 5000)
    expect(stateDuringSubmit).toBe('submitting')
  })

  it('auth and quota errors become needs_attention; other errors fail; both are retryable by the user', async () => {
    adapter.submitImpl = async () => { throw new AdapterError('auth', 'bad key', { status: 401 }) }
    const a = await runner.wait((await runner.submit(request())).id, 5000)
    expect(a.state).toBe('needs_attention'); expect(a.error).toEqual({ kind: 'auth', message: 'bad key' })
    adapter.submitImpl = async () => { throw new AdapterError('moderation', 'blocked') }
    expect((await runner.wait((await runner.submit(request())).id, 5000)).state).toBe('failed')
    adapter.submitImpl = async () => ({ kind: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }] })
    const retried = await runner.retry(a.id)
    expect((await runner.wait(retried.id, 5000)).state).toBe('succeeded')
    await expect(runner.retry(retried.id)).rejects.toThrow(/only failed/)
  })

  it('retries provider 5xx/429 with backoff but never after an opaque failure', async () => {
    let calls = 0
    adapter.submitImpl = async () => { if (++calls < 3) throw new AdapterError('unavailable', 'busy', { status: 503 }); return { kind: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }] } }
    expect((await runner.wait((await runner.submit(request())).id, 5000)).state).toBe('succeeded'); expect(calls).toBe(3)
    calls = 0
    adapter.submitImpl = async () => { calls++; throw new AdapterError('unavailable', 'socket hang up') } // no status: may have been accepted
    const failed = await runner.wait((await runner.submit(request())).id, 5000)
    expect(failed.state).toBe('failed'); expect(calls).toBe(1)
  })

  it('cancel aborts the live job and tells the provider to cancel', async () => {
    adapter.pollImpl = async () => ({ state: 'running' })
    const slow = new JobRunner(db, (() => { const r = new ProviderRegistry(); r.register(adapter); return r })(), assets, { sleep: (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, 20); signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true }) }) })
    const job = await slow.submit(request({ modelId: 'openrouter:fake/vid', params: { duration: 2 } }))
    await vi.waitFor(() => expect(db.getJob(job.id)!.remote).toBeDefined())
    const canceled = await slow.cancel(job.id)
    expect(canceled?.state).toBe('canceled'); expect(adapter.canceled).toEqual([{ id: 'r1' }])
    await slow.dispose()
  })

  it('resume: keeps polling jobs that have a remote id, requeues queued jobs, and never re-submits lost in-flight ones', async () => {
    const mk = (state: JobRecord['state'], remote?: Record<string, unknown>): JobRecord => {
      const id = `job_${state}_${String(Math.random()).slice(2, 6)}`
      const j: JobRecord = { id, createdAt: 1, updatedAt: 1, state, op: 'generate', modelId: remote === undefined ? 'openrouter:fake/img' : 'openrouter:fake/vid', provider: 'openrouter', request: request({ modelId: remote === undefined ? 'openrouter:fake/img' : 'openrouter:fake/vid', params: remote === undefined ? {} : { duration: 4 } }), attempt: 1, assetIds: [], origin: 'ui', ...(remote === undefined ? {} : { remote }) }
      db.insertJob(j); return j
    }
    const running = mk('running', { id: 'remote-9' }); const queued = mk('queued'); const lost = mk('submitting')
    const result = await runner.resume()
    expect(result).toMatchObject({ resumed: [running.id], requeued: [queued.id], lost: [lost.id] })
    expect((await runner.wait(running.id, 5000)).state).toBe('succeeded')
    expect((await runner.wait(queued.id, 5000)).state).toBe('succeeded')
    const lostNow = db.getJob(lost.id)!
    expect(lostNow.state).toBe('failed'); expect(lostNow.error?.message).toMatch(/lost-in-flight/)
    // submit was called once, for the queued job only
    expect(adapter.submits).toHaveLength(1)
  })

  it('shutdown leaves a running remote job untouched so the next boot resumes it (no cancel, no resubmit)', async () => {
    adapter.pollImpl = async () => ({ state: 'running' })
    const r = new ProviderRegistry(); r.register(adapter)
    const first = new JobRunner(db, r, assets, { sleep: (_ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, 15); signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true }) }) })
    const job = await first.submit(request({ modelId: 'openrouter:fake/vid', params: { duration: 2 } }))
    await vi.waitFor(() => expect(db.getJob(job.id)!.remote).toBeDefined())
    await first.dispose()
    expect(db.getJob(job.id)).toMatchObject({ state: 'running', remote: { id: 'r1' } })
    const submitsBefore = adapter.submits.length
    adapter.pollImpl = async () => ({ state: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }] })
    const second = new JobRunner(db, r, assets, { sleep: instantSleep })
    expect((await second.resume()).resumed).toEqual([job.id])
    expect((await second.wait(job.id, 5000)).state).toBe('succeeded')
    expect(adapter.submits.length).toBe(submitsBefore)
    await second.dispose()
  })

  it('stores provider notes with the asset and hands them back to later jobs (Gemini interaction ids)', async () => {
    adapter.submitImpl = async () => ({ kind: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png', notes: { interaction: 'v1_xyz' } }] })
    const first = await runner.wait((await runner.submit(request())).id, 5000)
    const id = first.assetIds[0]!
    expect(assets.recall(id, 'interaction')).toBe('v1_xyz')
    expect(assets.recall(id, 'nope')).toBeUndefined()
    assets.remember(id, 'bad key!', 'x'); assets.remember(id, 'long', 'x'.repeat(501))
    expect(assets.recall(id, 'bad key!')).toBeUndefined(); expect(assets.recall(id, 'long')).toBeUndefined()
    let seen: string | undefined
    adapter.submitImpl = async (_r, _m) => ({ kind: 'done', outputs: [{ bytes: new Uint8Array([...PNG, 1]), mediaType: 'image/png' }] })
    const adapterCtx = (runner as unknown as { context(s: AbortSignal): { recall?(r: { assetId: string }, k: string): string | undefined } }).context(new AbortController().signal)
    seen = adapterCtx.recall?.({ assetId: id }, 'interaction')
    expect(seen).toBe('v1_xyz')
  })

  it('times out polling jobs that never finish', async () => {
    adapter.pollImpl = async () => ({ state: 'running' })
    let t = 0
    const r = new ProviderRegistry(); r.register(adapter)
    const fast = new JobRunner(db, r, assets, { sleep: instantSleep, now: () => (t += 1_000_000), deadlineMs: { image: 1, video: 5_000_000 } })
    const done = await fast.wait((await fast.submit(request({ modelId: 'openrouter:fake/vid', params: { duration: 1 } }))).id, 5000)
    expect(done.state).toBe('failed'); expect(done.error?.kind).toBe('timeout')
    await fast.dispose()
  })

  it('limits concurrent submissions per provider', async () => {
    let active = 0; let peak = 0
    adapter.submitImpl = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 15)); active--; return { kind: 'done', outputs: [{ bytes: PNG, mediaType: 'image/png' }] } }
    const r = new ProviderRegistry(); r.register(adapter)
    const limited = new JobRunner(db, r, assets, { sleep: instantSleep, concurrency: 2 })
    const jobs = await Promise.all(Array.from({ length: 6 }, () => limited.submit(request())))
    await Promise.all(jobs.map(j => limited.wait(j.id, 5000)))
    expect(peak).toBeLessThanOrEqual(2); expect(db.listJobs({ states: ['succeeded'] })).toHaveLength(6)
    await limited.dispose()
  })
})

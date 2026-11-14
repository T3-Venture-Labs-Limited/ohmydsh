/**
 * Persistent job runner.
 * Rules: persist before any network call; never re-submit a job that may already have reached the provider
 * (a `submitting` job with no remote id after a restart becomes `failed: lost-in-flight`); resume polling for
 * jobs that have a remote id; download immediately on completion (provider URLs expire).
 */
import { EventEmitter } from 'node:events'
import { compositeBack, normalizeMask } from '../assets/masks.js'
import { AdapterError, ACTIVE_JOB_STATES, TERMINAL_JOB_STATES, estimateUsd, supports, capabilitiesFor, mediaKindOf, validateParams, type AdapterContext, type JobRecord, type JobState, type ModelDescriptor, type OperationRequest, type ProducedFile } from '../contracts.js'
import type { AssetService } from '../assets/service.js'
import { newId } from '../assets/service.js'
import type { StudioDb } from '../assets/db.js'
import type { ProviderRegistry } from '../providers/registry.js'

export interface RunnerOptions {
  now?: () => number
  /** Per-provider concurrent submissions. */
  concurrency?: number
  /** Hard deadline for a job (ms) per media kind. */
  deadlineMs?: { image: number; video: number }
  /** Backoff base for retryable errors. */
  backoffMs?: number
  maxAttempts?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  fetch?: typeof fetch
  logger?: { warn(message: string): void; info?(message: string): void }
}

export type JobEventMap = { job: [JobRecord] }

const DEFAULT_DEADLINE = { image: 10 * 60_000, video: 45 * 60_000 }

export class JobRunner {
  private readonly events = new EventEmitter()
  private readonly live = new Map<string, AbortController>()
  private readonly waiters = new Map<string, Set<(job: JobRecord) => void>>()
  private readonly inflightByProvider = new Map<string, number>()
  private readonly queueByProvider = new Map<string, (() => void)[]>()
  private disposed = false
  private readonly drives = new Set<Promise<void>>()

  constructor(
    private readonly db: StudioDb,
    private readonly registry: ProviderRegistry,
    private readonly assets: AssetService,
    private readonly options: RunnerOptions = {},
  ) { this.events.setMaxListeners(100) }

  private now(): number { return (this.options.now ?? Date.now)() }

  onJob(listener: (job: JobRecord) => void): () => void {
    this.events.on('job', listener)
    return () => { this.events.off('job', listener) }
  }

  get(id: string): JobRecord | undefined { return this.db.getJob(id) }

  /** Validate and price a request without spending anything: what submit() would check, minus the network. */
  async preview(request: OperationRequest): Promise<{ ok: boolean; issues: { path: string; message: string }[]; estimateUsd?: number; model?: { id: string; label: string; async: 'sync' | 'job' }; configured: boolean }> {
    let resolved
    try { resolved = await this.registry.resolveModel(request.modelId) } catch (error) { return { ok: false, configured: false, issues: [{ path: 'modelId', message: error instanceof Error ? error.message : String(error) }] } }
    const { adapter, model } = resolved
    const kind = mediaKindOf(model.capabilities); const needed = capabilitiesFor(request, kind)
    const issues: { path: string; message: string }[] = []
    if (!supports(model, needed)) issues.push({ path: 'op', message: `${model.label} cannot do ${request.op} (needs ${needed.join(', ')})` })
    const checked = validateParams(model, request.params)
    issues.push(...checked.issues, ...(adapter.validate?.({ ...request, params: checked.value }, model) ?? []))
    const configured = await adapter.isConfigured().catch(() => false)
    if (!configured) issues.push({ path: 'provider', message: `${adapter.id} is not configured. Add its API key in Settings > Plugins > Studio.` })
    const normalized = { ...request, params: checked.value }
    const estimate = adapter.estimate?.(normalized, model)?.usd ?? estimateUsd(model.pricing, checked.value, 1) ?? this.estimateFromSource(model, normalized)
    return { ok: issues.length === 0, configured, issues, ...(estimate === undefined ? {} : { estimateUsd: estimate }), model: { id: model.id, label: model.label, async: model.async } }
  }

  /** Validate, persist, then start. Returns the queued job; use `wait` to await completion. */
  async submit(request: OperationRequest, meta: { agentJobId?: string } = {}): Promise<JobRecord> {
    const { adapter, model } = await this.registry.resolveModel(request.modelId)
    const kind = mediaKindOf(model.capabilities)
    const needed = capabilitiesFor(request, kind)
    if (!supports(model, needed)) throw new AdapterError('unsupported', `${model.label} cannot do ${request.op} (needs ${needed.join(', ')})`)
    const checked = validateParams(model, request.params)
    const issues = [...checked.issues, ...(adapter.validate?.({ ...request, params: checked.value }, model) ?? [])]
    if (issues.length > 0) throw new AdapterError('invalid', issues.map(i => `${i.path}: ${i.message}`).join('; '))
    if (!(await adapter.isConfigured())) throw new AdapterError('auth', `${adapter.id} is not configured. Add its API key in Settings > Plugins > Studio.`)
    const normalized: OperationRequest = { ...request, params: checked.value }
    const estimate = adapter.estimate?.(normalized, model)?.usd ?? estimateUsd(model.pricing, checked.value, 1) ?? this.estimateFromSource(model, normalized)
    const now = this.now()
    const job: JobRecord = {
      id: `job_${newId(now)}`, createdAt: now, updatedAt: now, state: 'queued', op: request.op, modelId: model.id, provider: model.provider,
      request: normalized, attempt: 0, assetIds: [], origin: request.origin ?? 'ui',
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(meta.agentJobId === undefined ? {} : { agentJobId: meta.agentJobId }),
      ...(estimate === undefined ? {} : { estimateUsd: estimate }),
    }
    this.db.insertJob(job)
    this.emit(job)
    this.start(job.id)
    return job
  }

  /**
   * Inpaint post-process: paste the model output back over the original wherever the mask says "keep", so pixels outside the mask are
   * bit-exact the original regardless of how the model regenerated the frame (markup / overlay-prompt models redraw everything).
   * Soft-fails: when sharp is missing or anything throws, the raw model output is stored unchanged.
   */
  private async compositeInpaint(request: OperationRequest, outputs: readonly ProducedFile[], signal: AbortSignal, feather: number): Promise<ProducedFile[] | undefined> {
    try {
      const source = await this.assets.readInput(request.inputs.source!)
      if (source.width === undefined || source.height === undefined) return undefined
      const rawMask = await this.assets.readInput(request.inputs.mask!)
      const { png: mask } = await normalizeMask(rawMask.bytes, { width: source.width, height: source.height })
      const out: ProducedFile[] = []
      for (const file of outputs) {
        const generated = file.bytes ?? (file.url === undefined ? undefined : await this.assets.download(file.url, file.headers, signal))
        if (generated === undefined) return undefined
        out.push({ ...file, bytes: await compositeBack(source.bytes, generated, mask, { feather }), mediaType: 'image/png', ...(file.url === undefined ? {} : { }) })
        delete (out[out.length - 1] as { url?: string }).url
      }
      return out
    } catch (error) {
      if (signal.aborted) throw error
      this.options.logger?.warn(`dsh-studio: inpaint composite-back skipped: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Per-megapixel-second pricing (video upscalers) needs the source clip's size and length. */
  private estimateFromSource(model: ModelDescriptor, request: OperationRequest): number | undefined {
    if (model.pricing?.unit !== 'megapixel-second') return undefined
    const ref = request.inputs.video ?? request.inputs.source
    const a = ref === undefined ? undefined : this.db.getAsset(ref.assetId)
    if (a?.width === undefined || a.height === undefined || a.durationMs === undefined) return undefined
    const factor = typeof request.params.upscale_factor === 'number' ? request.params.upscale_factor : 1
    const megapixels = (a.width * factor * a.height * factor) / 1_000_000
    return Math.round(model.pricing.usd * megapixels * (a.durationMs / 1000) * 10_000) / 10_000
  }

  /** Resolve once the job reaches a terminal state (or needs attention). */
  wait(id: string, timeoutMs?: number): Promise<JobRecord> {
    const current = this.db.getJob(id)
    if (current !== undefined && this.isSettled(current.state)) return Promise.resolve(current)
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (job: JobRecord): void => { if (timer !== undefined) clearTimeout(timer); this.waiters.get(id)?.delete(done); resolve(job) }
      let set = this.waiters.get(id); if (set === undefined) { set = new Set(); this.waiters.set(id, set) }
      set.add(done)
      if (timeoutMs !== undefined) timer = setTimeout(() => { this.waiters.get(id)?.delete(done); const latest = this.db.getJob(id); latest === undefined ? reject(new Error(`Unknown job ${id}`)) : resolve(latest) }, timeoutMs)
    })
  }

  private isSettled(state: JobState): boolean { return TERMINAL_JOB_STATES.includes(state) || state === 'needs_attention' }

  async cancel(id: string): Promise<JobRecord | undefined> {
    const job = this.db.getJob(id)
    if (job === undefined || this.isSettled(job.state)) return job
    this.live.get(id)?.abort(new Error('canceled'))
    const { adapter } = await this.registry.resolveModel(job.modelId).catch(() => ({ adapter: undefined }))
    if (job.remote !== undefined && adapter?.cancel !== undefined) {
      await adapter.cancel(job.remote, this.context(new AbortController().signal)).catch(error => this.options.logger?.warn(`studio: provider cancel failed for ${id}: ${String(error)}`))
    }
    return this.settle(this.db.getJob(id) ?? job, 'canceled', { message: 'Canceled' })
  }

  /** Retry a failed / needs_attention job as a new submission (a fresh paid call: the caller asked for it). */
  async retry(id: string): Promise<JobRecord> {
    const job = this.db.getJob(id)
    if (job === undefined) throw new Error(`Unknown job ${id}`)
    if (job.state !== 'failed' && job.state !== 'needs_attention' && job.state !== 'canceled') throw new Error(`Job ${id} is ${job.state}; only failed, canceled or needs_attention jobs can be retried`)
    return this.submit(job.request, job.agentJobId === undefined ? {} : { agentJobId: job.agentJobId })
  }

  /** Called once at boot: resume polling, fail lost submissions, requeue what never left the queue. */
  async resume(): Promise<{ resumed: string[]; lost: string[]; requeued: string[] }> {
    const resumed: string[] = []; const lost: string[] = []; const requeued: string[] = []
    for (const job of this.db.listJobs({ states: ACTIVE_JOB_STATES, limit: 500 })) {
      if (job.remote !== undefined) { resumed.push(job.id); this.start(job.id) }
      else if (job.state === 'queued') { requeued.push(job.id); this.start(job.id) }
      else { lost.push(job.id); this.settle(job, 'failed', { error: { kind: 'unknown', message: 'The request was in flight when Studio restarted and may have been billed. It was not re-submitted; check the provider dashboard, then retry if needed (lost-in-flight).' } }) }
    }
    return { resumed, lost, requeued }
  }

  /** Stop all live work and resolve once every drive loop has unwound (safe to close the database afterwards). */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.live.values()) controller.abort(new Error('runner disposed'))
    await Promise.allSettled([...this.drives])
    this.live.clear(); this.events.removeAllListeners()
  }

  /** Resolves when no job is being driven (tests, graceful shutdown). */
  async idle(): Promise<void> { while (this.drives.size > 0) await Promise.allSettled([...this.drives]) }

  // ---------------------------------------------------------------- internals
  private emit(job: JobRecord): void {
    this.events.emit('job', job)
    if (this.isSettled(job.state)) { const set = this.waiters.get(job.id); if (set !== undefined) for (const w of [...set]) w(job); this.waiters.delete(job.id) }
  }

  private save(job: JobRecord, patch: Partial<JobRecord>): JobRecord {
    const next: JobRecord = { ...job, ...patch, updatedAt: this.now() }
    try { this.db.saveJob(next) } catch (error) { if (this.disposed) return next; throw error }
    this.emit(next); return next
  }

  private settle(job: JobRecord, state: 'succeeded' | 'failed' | 'canceled' | 'needs_attention', patch: Partial<JobRecord> & { message?: string } = {}): JobRecord {
    const { message, ...rest } = patch
    return this.save(job, { ...rest, state, finishedAt: this.now(), ...(message === undefined ? {} : { message }) })
  }

  private context(signal: AbortSignal): AdapterContext {
    return { signal, fetch: this.options.fetch ?? fetch, readInput: ref => this.assets.readInput(ref), publicUrl: ref => this.assets.publicUrl(ref.assetId, this.now()), recall: (ref, key) => this.assets.recall(ref.assetId, key) }
  }

  private async acquire(provider: string, signal: AbortSignal): Promise<() => void> {
    const limit = this.options.concurrency ?? 3
    const used = this.inflightByProvider.get(provider) ?? 0
    if (used >= limit) {
      await new Promise<void>((resolve, reject) => {
        const queue = this.queueByProvider.get(provider) ?? []; this.queueByProvider.set(provider, queue)
        const entry = (): void => resolve(); queue.push(entry)
        signal.addEventListener('abort', () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(signal.reason) }, { once: true })
      })
    }
    this.inflightByProvider.set(provider, (this.inflightByProvider.get(provider) ?? 0) + 1)
    return () => {
      this.inflightByProvider.set(provider, Math.max(0, (this.inflightByProvider.get(provider) ?? 1) - 1))
      this.queueByProvider.get(provider)?.shift()?.()
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms, signal)
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
      const onAbort = (): void => { clearTimeout(timer); reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private start(id: string): void {
    const p = this.drive(id).finally(() => { this.drives.delete(p) })
    this.drives.add(p)
  }

  private async drive(id: string): Promise<void> {
    if (this.disposed || this.live.has(id)) return
    let job = this.db.getJob(id)
    if (job === undefined || this.isSettled(job.state)) return
    const controller = new AbortController(); this.live.set(id, controller)
    const signal = controller.signal
    let release: (() => void) | undefined
    try {
      const { adapter, model } = await this.registry.resolveModel(job.modelId)
      const kind = mediaKindOf(model.capabilities)
      const deadline = this.now() + (this.options.deadlineMs ?? DEFAULT_DEADLINE)[kind]
      if (job.remote === undefined) {
        release = await this.acquire(job.provider, signal)
        // Persist 'submitting' BEFORE the network call: a crash here must be detected, never silently retried.
        job = this.save(job, { state: 'submitting', startedAt: job.startedAt ?? this.now(), attempt: job.attempt + 1 })
        const result = await this.submitWithRetry(adapter, job, model, signal)
        if (result.kind === 'done') { release(); release = undefined; await this.finalize(job, model, result.outputs, result.cost, signal); return }
        job = this.save(job, { state: 'running', remote: result.remote })
        release(); release = undefined
        await this.pollLoop(adapter, job, model, signal, deadline, result.pollAfterMs)
      } else {
        await this.pollLoop(adapter, job, model, signal, deadline, 2000)
      }
    } catch (error) {
      const latest = this.db.getJob(id) ?? job
      if (this.isSettled(latest.state)) return
      // Shutdown is not a cancel: leave the persisted state exactly as it was so resume() can pick the job up on the next boot
      // (a job with a remote id keeps polling; one that was mid-submit becomes lost-in-flight, never re-submitted).
      if (this.disposed) return
      if (signal.aborted) { this.settle(latest, 'canceled', { message: 'Canceled' }); return }
      const e = error instanceof AdapterError ? error : new AdapterError('unknown', error instanceof Error ? error.message : String(error), { cause: error })
      if (e.kind === 'auth' || e.kind === 'quota') this.settle(latest, 'needs_attention', { error: { kind: e.kind, message: e.message } })
      else this.settle(latest, 'failed', { error: { kind: e.kind, message: e.message } })
    } finally {
      release?.()
      this.live.delete(id)
    }
  }

  private async submitWithRetry(adapter: import('../contracts.js').ProviderAdapter, job: JobRecord, model: ModelDescriptor, signal: AbortSignal): ReturnType<import('../contracts.js').ProviderAdapter['submit']> {
    const max = this.options.maxAttempts ?? 3
    for (let attempt = 1; ; attempt++) {
      try { return await adapter.submit(job.request, model, this.context(signal)) } catch (error) {
        // Only retry when the provider proves nothing was accepted (retryable + not an opaque transport failure after send).
        if (!(error instanceof AdapterError) || !error.retryable || error.status === undefined || attempt >= max) throw error
        await this.sleep((this.options.backoffMs ?? 2000) * 2 ** (attempt - 1), signal)
      }
    }
  }

  private async pollLoop(adapter: import('../contracts.js').ProviderAdapter, start: JobRecord, model: ModelDescriptor, signal: AbortSignal, deadline: number, firstDelay: number): Promise<void> {
    if (adapter.poll === undefined) throw new AdapterError('unsupported', `${adapter.id} returned a remote job but cannot poll it`)
    let job = start; let delay = firstDelay; let failures = 0
    for (;;) {
      signal.throwIfAborted()
      await this.sleep(delay, signal)
      signal.throwIfAborted()
      if (this.now() > deadline) throw new AdapterError('timeout', 'The provider did not finish in time')
      let result
      try { result = await adapter.poll(job.remote!, model, this.context(signal)); failures = 0 } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof AdapterError && !error.retryable) throw error
        if (++failures >= 5) throw error
        delay = Math.min(60_000, delay * 2); continue
      }
      if (result.state === 'done') { await this.finalize(job, model, result.outputs, result.cost, signal); return }
      if (result.state === 'failed') throw result.error
      job = this.save(job, { state: 'running', ...(result.progress === undefined ? {} : { progress: result.progress }), ...(result.message === undefined ? {} : { message: result.message }) })
      delay = result.pollAfterMs ?? Math.min(30_000, Math.round(delay * 1.4))
    }
  }

  private async finalize(job: JobRecord, model: ModelDescriptor, outputs: readonly ProducedFile[], cost: { usd: number; source: 'provider' | 'estimate' } | undefined, signal: AbortSignal): Promise<void> {
    job = this.save(job, { state: 'finalizing' })
    const request = job.request
    const parents = [
      ...(request.inputs.source === undefined ? [] : [{ assetId: request.inputs.source.assetId, role: (request.op === 'upscale' ? 'upscale-of' : request.op === 'extend' ? 'extend-of' : 'source') as 'source' | 'upscale-of' | 'extend-of' }]),
      ...(request.inputs.video === undefined ? [] : [{ assetId: request.inputs.video.assetId, role: (request.op === 'upscale' ? 'upscale-of' : request.op === 'extend' ? 'extend-of' : 'video') as 'video' | 'upscale-of' | 'extend-of' }]),
      ...(request.inputs.references ?? []).map(r => ({ assetId: r.assetId, role: 'reference' as const })),
      ...(request.inputs.mask === undefined ? [] : [{ assetId: request.inputs.mask.assetId, role: 'mask' as const }]),
      ...(request.inputs.firstFrame === undefined ? [] : [{ assetId: request.inputs.firstFrame.assetId, role: 'first_frame' as const }]),
      ...(request.inputs.lastFrame === undefined ? [] : [{ assetId: request.inputs.lastFrame.assetId, role: 'last_frame' as const }]),
    ]
    let composited = false
    if (request.op === 'inpaint' && request.inputs.source !== undefined && request.inputs.mask !== undefined) {
      // Outpaint (source made by /assets/expand or studio_make expand): the model's new area rarely matches the old tone exactly, so blend
      // across the overlap band with a wide feather instead of a hard seam. Plain inpaints keep a tight 1.5 px edge.
      const outpaint = this.db.getAsset(request.inputs.source.assetId)?.tags.includes('outpaint') === true
      const src = this.db.getAsset(request.inputs.source.assetId)
      // Wide enough to hide a tone mismatch, but never wider than a quarter of the shorter side or half of what the mask allows.
      const feather = outpaint ? Math.max(1.5, Math.min(10, Math.min(src?.width ?? 0, src?.height ?? 0) / 40)) : 1.5
      const result = await this.compositeInpaint(request, outputs, signal, feather)
      if (result !== undefined) { outputs = result; composited = true }
    }
    const usd = cost?.usd ?? job.estimateUsd
    const perOutput = usd === undefined ? undefined : Math.round((usd / Math.max(1, outputs.length)) * 10_000) / 10_000
    const ids: string[] = []
    for (const file of outputs) {
      const asset = await this.assets.ingestProduced(file, {
        source: request.op === 'upscale' ? 'derived' : 'generated', jobId: job.id, op: request.op, provider: model.provider, modelId: model.id,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }), ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
        params: composited ? { ...request.params, composited: true } : request.params, ...(perOutput === undefined ? {} : { costUsd: perOutput }), ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.tags === undefined ? {} : { tags: request.tags }), parents,
      }, signal)
      ids.push(asset.id)
      for (const [k, v] of Object.entries(file.notes ?? {})) this.assets.remember(asset.id, k, v)
      const publicUrl = file.meta?.publicUrl
      if (typeof publicUrl === 'string') this.assets.rememberPublicUrl(asset.id, publicUrl, typeof file.meta?.expiresAt === 'number' ? file.meta.expiresAt : this.now() + 50 * 60_000)
    }
    this.settle(job, 'succeeded', { assetIds: ids, progress: 1, ...(usd === undefined ? {} : { costUsd: usd, costSource: cost?.source ?? 'estimate' }) })
  }
}

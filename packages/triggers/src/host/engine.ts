/**
 * The trigger engine: one place where every source's events are checked (dedupe, enabled, paused, filter, limits),
 * logged, and handed to the launcher asynchronously. Also owns the file watchers and the management operations used
 * by the page routes and the agent tools. Free of cordis so it can be tested with fakes.
 */
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  HOOK_BASE,
  type Automation, type AutomationView, type FileSource, type RunRow, type SaveResponse, type TriggersState,
} from '../shared/types.ts'
import { generateSecret, secretHint } from './auth.ts'
import { ComposioBridge, managedInstance, type ComposioServiceLike } from './composio.ts'
import type { LaunchResult } from './launcher.ts'
import { renderPrompt, renderTitle, type FileInfo, type TriggerEvent } from './prompt.ts'
import { rateDecision, type TriggersStore } from './store.ts'
import { errorText, globToRegExp, newId } from './util.ts'
import { automationFrom, ValidationError } from './validate.ts'
import { baselineKey, FileWatcher, scanFiles, type FileMatch } from './watcher.ts'

export const MAX_FAILURES = 3

export interface EngineDeps {
  store: TriggersStore
  /** Deliver to a chat (launcher). Called serialised per automation. */
  deliver: (automation: Automation, event: { runId: string; text: string; title: string }) => Promise<LaunchResult>
  origin: () => string
  hasAutomationModels: () => boolean
  hasComposio: () => boolean
  /** dsh-composio's `ctx.composio` service, when installed. */
  composio?: () => ComposioServiceLike | undefined
  workspaces: () => { path: string; title: string }[]
  defaultCwd: () => string
  queuedFor?: (automationId: string) => number
  log: { info(m: string): void; warn(m: string): void }
  now?: () => number
  /** File watcher catch-up interval (tests). */
  catchUpMs?: number
}

export type FireOutcome = { row: RunRow; done: Promise<RunRow> }

const SKIP_DONE = (row: RunRow): FireOutcome => ({ row, done: Promise.resolve(row) })

export class TriggersEngine {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly watchers = new Map<string, FileWatcher>()
  /** File events deferred by a rate limit: logged once, retried by the next catch-up scan. */
  private readonly deferred = new Set<string>()
  private stopped = false
  readonly composio: ComposioBridge

  constructor(private readonly deps: EngineDeps) {
    this.composio = new ComposioBridge(deps.composio ?? (() => undefined), () => deps.store.data.automations, deps.log)
  }

  private get store(): TriggersStore { return this.deps.store }
  private now(): number { return this.deps.now?.() ?? Date.now() }

  // ---------- firing ----------

  /**
   * Check and log one event, then deliver it asynchronously. `row` is the first logged row (pending or skipped);
   * `done` resolves with the final row.
   */
  async fire(automation: Automation, event: TriggerEvent): Promise<FireOutcome> {
    const test = event.test === true
    const base = (status: RunRow['status'], extra: Partial<RunRow> = {}): RunRow => ({
      runId: newId('run'), automationId: automation.id, automationName: automation.name, at: event.receivedAt,
      source: event.source, eventId: event.eventId.slice(0, 200), summary: event.summary.slice(0, 200), bytes: event.bytes, status,
      ...(test ? { test: true } : {}), ...extra,
    })
    const skip = async (reason: string): Promise<FireOutcome> => { const row = base('skipped', { reason }); await this.store.log(row); return SKIP_DONE(row) }

    if (!test && this.store.hasSeen(automation.id, event.eventId)) return skip('duplicate')
    if (!automation.enabled && !test) return skip('disabled')
    if (this.store.data.paused && !test) return skip('paused')
    if (!test && automation.source.kind === 'webhook' && automation.source.events.length > 0 && !automation.source.events.includes(event.eventType ?? '')) {
      this.store.markSeen(automation.id, event.eventId)
      return skip('filtered')
    }
    if (!test) {
      const limited = rateDecision(this.store, automation, this.now())
      if (limited !== undefined) return skip(limited)
      this.store.markSeen(automation.id, event.eventId)
    }

    const row = base('pending')
    await this.store.log(row)
    const done = this.serialise(automation.id, () => this.deliverRow(automation.id, event, row))
    return { row, done }
  }

  private serialise<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(key) ?? Promise.resolve()
    const next = prior.then(task, task)
    const tail = next.catch(() => {})
    this.chains.set(key, tail)
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key) })
    return next
  }

  private async deliverRow(automationId: string, event: TriggerEvent, row: RunRow): Promise<RunRow> {
    const automation = this.store.get(automationId)
    if (automation === undefined) { const r: RunRow = { ...row, status: 'skipped', reason: 'automation-deleted' }; await this.store.log(r); return r }
    const input = { automation, event }
    let final: RunRow
    try {
      const result = await this.deps.deliver(automation, { runId: row.runId, text: renderPrompt(input), title: renderTitle(automation.target.title, input) })
      final = { ...row, status: result.queued === true ? 'queued' : 'delivered', sessionId: result.sessionId, ...(result.model === undefined ? {} : { model: result.model }) }
      if (result.queued !== true) await this.succeeded(automation)
    } catch (error) {
      final = { ...row, status: 'failed', error: errorText(error).slice(0, 300) }
      await this.failed(automation, final.error ?? '')
    }
    await this.store.log(final)
    return final
  }

  private async succeeded(automation: Automation): Promise<void> {
    if (automation.consecutiveFailures === 0) return
    automation.consecutiveFailures = 0
    await this.store.save().catch(() => {})
  }

  private async failed(automation: Automation, message: string): Promise<void> {
    automation.consecutiveFailures += 1
    if (automation.consecutiveFailures >= MAX_FAILURES && automation.enabled) {
      automation.enabled = false
      this.deps.log.warn(`triggers: "${automation.name}" disabled after ${String(MAX_FAILURES)} consecutive delivery failures`)
      this.syncWatchers()
      this.syncComposioEnabled(automation)
    }
    this.deps.log.warn(`triggers: delivery for "${automation.name}" failed: ${message.slice(0, 200)}`)
    await this.store.save().catch(() => {})
  }

  /** Queued reuse deliveries resolved by the launcher (flush, drop or error). */
  async queueResult(runIds: readonly string[], result: { sessionId: string; model?: string } | { dropped: true; reason: string } | { error: string }): Promise<void> {
    for (const id of runIds) {
      const prior = this.store.run(id)
      if (prior === undefined) continue
      const next: RunRow = 'error' in result ? { ...prior, status: 'failed', error: result.error }
        : 'dropped' in result ? { ...prior, status: 'skipped', reason: result.reason }
          : { ...prior, status: 'delivered', sessionId: result.sessionId, ...(result.model === undefined ? {} : { model: result.model }) }
      await this.store.log(next)
    }
    const first = runIds[0] === undefined ? undefined : this.store.run(runIds[0])
    const automation = first === undefined ? undefined : this.store.get(first.automationId)
    if (automation === undefined) return
    if ('error' in result) await this.failed(automation, result.error)
    else if (!('dropped' in result)) await this.succeeded(automation)
  }

  // ---------- sources ----------

  /** Webhook: build the event from the raw body (auth already verified). */
  webhookEvent(body: Buffer, headers: Record<string, string | string[] | undefined>, remote: string | undefined, test = false): TriggerEvent {
    const h = (n: string): string | undefined => { const v = headers[n]; return (Array.isArray(v) ? v[0] : v)?.trim() || undefined }
    const text = body.toString('utf8')
    let data: Record<string, unknown>
    try {
      const parsed = JSON.parse(text) as unknown
      data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { body: parsed }
    } catch { data = { text } }
    const bodyType = typeof data['type'] === 'string' ? data['type'] : typeof data['event'] === 'string' ? data['event'] : undefined
    const eventType = h('x-github-event') ?? h('x-event-type') ?? bodyType
    const id = h('x-github-delivery') ?? h('webhook-id') ?? h('x-request-id') ?? h('idempotency-key')
    const eventId = id === undefined ? `sha256:${createHash('sha256').update(body).digest('hex')}` : `id:${id.slice(0, 160)}`
    const via = h('x-github-event') !== undefined ? 'github' : h('webhook-id') !== undefined ? 'standard-webhooks' : undefined
    const kind = via === undefined ? (eventType === undefined ? '' : ` (${eventType})`) : ` (${via}${eventType === undefined ? '' : `: ${eventType}`})`
    return { source: 'webhook', eventId, data, summary: `POST from ${remote ?? 'unknown'}${kind}`.slice(0, 200), bytes: body.length, receivedAt: this.now(), eventType, ...(test ? { test: true } : {}) }
  }

  fileEvent(match: Pick<FileMatch, 'file' | 'real' | 'sibling'>, test = false): TriggerEvent {
    const { file } = match
    const data: Record<string, unknown> = { file: { path: file.path, name: file.name, dirname: file.dirname, dir: file.dir, size: file.size, mtime: new Date(file.mtime).toISOString() } }
    if (match.sibling !== undefined) data['sibling'] = match.sibling
    return { source: 'file', eventId: `file:${match.real}`, data, file, summary: `${file.name} in ${file.dirname}`, bytes: file.size, receivedAt: this.now(), ...(test ? { test: true } : {}) }
  }

  /** Composio events (called by dsh-composio through `ctx.triggers.ingest`). */
  async ingest(event: { source: 'composio'; triggerSlug: string; triggerInstanceId?: string; eventId: string; data: Record<string, unknown> }): Promise<{ matched: number }> {
    const slug = String(event.triggerSlug ?? '').toUpperCase()
    const matching = this.store.data.automations.filter((a) => a.source.kind === 'composio' && a.source.triggerSlug === slug
      && (a.source.triggerInstanceId === undefined || a.source.triggerInstanceId === event.triggerInstanceId))
    const data = typeof event.data === 'object' && event.data !== null ? event.data : {}
    const bytes = JSON.stringify(data).length
    let matched = 0
    for (const a of matching) {
      const outcome = await this.fire(a, { source: 'composio', eventId: `composio:${String(event.eventId).slice(0, 160)}`, data, eventType: slug, summary: `Composio ${slug}`, bytes, receivedAt: this.now() })
      if (outcome.row.status === 'pending') matched++
    }
    return { matched }
  }

  // ---------- file watchers ----------

  /** Start watchers for enabled file automations, stop the rest. Idempotent. */
  syncWatchers(): void {
    if (this.stopped || !this.store.loaded) return
    const wanted = new Map(this.store.data.automations.filter((a) => a.enabled && a.source.kind === 'file').map((a) => [a.id, a]))
    for (const [id, w] of this.watchers) {
      const a = wanted.get(id)
      if (a === undefined || a.source.kind !== 'file' || baselineKey(a.source) !== baselineKey(w.source) || a.source.settleMs !== w.source.settleMs || JSON.stringify(a.source.requireSibling) !== JSON.stringify(w.source.requireSibling)) {
        w.stop(); this.watchers.delete(id)
      }
    }
    for (const [id, a] of wanted) {
      if (this.watchers.has(id) || a.source.kind !== 'file') continue
      const w = new FileWatcher(id, a.source, {
        isKnown: (real) => this.store.isKnownFile(id, real),
        markKnown: (reals) => { this.store.markKnownFiles(id, reals) },
        hasBaseline: (key) => this.store.hasBaseline(id, key),
        markBaseline: (key) => { this.store.setBaseline(id, key) },
        onMatch: (m) => this.onFileMatch(id, m),
        log: this.deps.log,
        ...(this.deps.catchUpMs === undefined ? {} : { catchUpMs: this.deps.catchUpMs }),
      })
      this.watchers.set(id, w)
      void w.start()
    }
  }

  watcher(id: string): FileWatcher | undefined { return this.watchers.get(id) }

  private async onFileMatch(id: string, match: FileMatch): Promise<boolean> {
    const automation = this.store.get(id)
    if (automation === undefined) return false
    if (this.deferred.has(match.real) && (this.store.data.paused || rateDecision(this.store, automation, this.now()) !== undefined)) return false
    const outcome = await this.fire(automation, this.fileEvent(match))
    if (outcome.row.status === 'skipped' && /rate-limited|min-interval|paused/.test(outcome.row.reason ?? '')) {
      // Retried by the next catch-up scan; log the deferral once per file.
      this.deferred.add(match.real)
      return false
    }
    this.deferred.delete(match.real)
    return true
  }

  private syncComposioEnabled(a: Automation): void {
    const instance = managedInstance(a)
    if (instance !== undefined) void this.composio.syncEnabled(instance)
  }

  stop(): void {
    this.stopped = true
    for (const w of this.watchers.values()) w.stop()
    this.watchers.clear()
  }

  // ---------- management ----------

  view(a: Automation): AutomationView {
    const secret = this.store.secrets[a.id]
    return {
      ...a,
      ...(a.source.kind === 'webhook' ? { webhookUrl: `${this.deps.origin()}${HOOK_BASE}/${a.id}` } : {}),
      secretHint: a.source.kind === 'webhook' && a.source.auth !== 'none' ? secretHint(secret) : null,
      lastRun: this.store.lastRun(a.id),
    }
  }

  state(): TriggersState {
    const workspaces = this.deps.workspaces()
    return {
      paused: this.store.data.paused,
      automations: this.store.data.automations.map((a) => this.view(a)),
      runs: this.store.recentRuns(100),
      origin: this.deps.origin(),
      hasAutomationModels: this.deps.hasAutomationModels(),
      hasComposio: this.deps.hasComposio(),
      workspaces,
      defaultCwd: this.deps.defaultCwd(),
    }
  }

  /** Create or update. Returns the secret only when a new one was generated (create, or switched to a signed auth). */
  get(id: string): Automation | undefined { return this.store.get(id) }

  async save(body: unknown): Promise<SaveResponse> {
    const reqId = typeof (body as { id?: unknown })?.id === 'string' ? (body as { id: string }).id : undefined
    const prior = reqId === undefined ? undefined : this.store.get(reqId)
    if (reqId !== undefined && prior === undefined) throw new ValidationError('unknown automation id')
    const { automation, warnings } = automationFrom(body, prior, this.deps.defaultCwd(), this.now())
    // Composio: create the trigger instance first; an error fails the save before anything is stored.
    const prepared = await this.composio.prepare(automation, prior)
    warnings.push(...prepared.warnings)
    let secret: string | undefined
    const list = this.store.data.automations
    const index = list.findIndex((a) => a.id === automation.id)
    try {
      const needsSecret = automation.source.kind === 'webhook' && automation.source.auth !== 'none'
      if (needsSecret && this.store.secrets[automation.id] === undefined) { secret = generateSecret(); this.store.secrets[automation.id] = secret; await this.store.saveSecrets() }
      if (!needsSecret && this.store.secrets[automation.id] !== undefined) { delete this.store.secrets[automation.id]; await this.store.saveSecrets() }
      if (index === -1) list.push(automation); else list[index] = automation
      await this.store.save()
    } catch (error) {
      // Roll back the in-memory list and the instance created for this save.
      if (index === -1) this.store.data.automations = this.store.data.automations.filter((a) => a !== automation)
      else if (prior !== undefined) this.store.data.automations[index] = prior
      if (prepared.created !== undefined) await this.composio.release(prepared.created)
      throw error
    }
    this.syncWatchers()
    warnings.push(...await this.composio.afterSave(automation, prior))
    return { automation: this.view(automation), ...(secret === undefined ? {} : { secret }), warnings }
  }

  async remove(id: string): Promise<void> {
    const removed = this.store.get(id)
    if (removed === undefined) throw new ValidationError('unknown automation id')
    this.store.data.automations = this.store.data.automations.filter((a) => a.id !== id)
    this.store.forget(id)
    await this.store.save()
    this.syncWatchers()
    const instance = managedInstance(removed)
    if (instance !== undefined) { await this.composio.release(instance); if (this.composio.inUse(instance)) await this.composio.syncEnabled(instance) }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const a = this.store.get(id)
    if (a === undefined) throw new ValidationError('unknown automation id')
    a.enabled = enabled
    if (enabled) a.consecutiveFailures = 0
    a.updatedAt = this.now()
    await this.store.save()
    this.syncWatchers()
    const instance = managedInstance(a)
    if (instance !== undefined) await this.composio.syncEnabled(instance)
  }

  async setPaused(paused: boolean): Promise<void> { this.store.data.paused = paused; await this.store.save() }

  async rotateSecret(id: string): Promise<SaveResponse> {
    const a = this.store.get(id)
    if (a === undefined) throw new ValidationError('unknown automation id')
    if (a.source.kind !== 'webhook' || a.source.auth === 'none') throw new ValidationError('only webhook automations with a signed auth have a secret')
    const secret = generateSecret()
    this.store.secrets[id] = secret
    await this.store.saveSecrets()
    return { automation: this.view(a), secret, warnings: [] }
  }

  /** A sample event for preview / test. `payload` replaces the event data (webhook/composio) or the file path (file). */
  async sampleEvent(a: Automation, payload: unknown): Promise<TriggerEvent> {
    const now = this.now()
    const data = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : payload === undefined ? undefined : { body: payload }
    const id = `test:${newId('evt')}`
    if (a.source.kind === 'file') {
      const file = await this.sampleFile(a.source, typeof (payload as { path?: unknown })?.path === 'string' ? (payload as { path: string }).path : undefined)
      return { ...this.fileEvent({ file, real: file.path }, true), eventId: id }
    }
    if (a.source.kind === 'composio') {
      const d = data ?? { sample: true, note: 'Sample Composio event from the Triggers page' }
      return { source: 'composio', eventId: id, data: d, eventType: a.source.triggerSlug, summary: `Test: Composio ${a.source.triggerSlug}`, bytes: JSON.stringify(d).length, receivedAt: now, test: true }
    }
    const d = data ?? { sample: true, message: 'Test event from the Triggers page' }
    return { source: 'webhook', eventId: id, data: d, eventType: typeof d['type'] === 'string' ? d['type'] : undefined, summary: 'Test event', bytes: JSON.stringify(d).length, receivedAt: now, test: true }
  }

  /** Newest existing match (so a test run has a real file to read), else a placeholder path. */
  private async sampleFile(source: FileSource, path: string | undefined): Promise<FileInfo> {
    let chosen = path
    if (chosen === undefined) {
      const re = globToRegExp(source.pattern)
      const files = await scanFiles(source.path, (n) => re.test(n), 4, 2000)
      let best: { p: string; m: number } | undefined
      for (const f of files) { try { const s = await stat(f); if (best === undefined || s.mtimeMs > best.m) best = { p: f, m: s.mtimeMs } } catch { /* gone */ } }
      chosen = best?.p ?? join(source.path, 'example', source.pattern.replace(/[*?[\]{}]/g, 'x'))
    }
    let size = 0; let mtime = this.now()
    try { const s = await stat(chosen); size = s.size; mtime = s.mtimeMs; chosen = await realpath(chosen) } catch { /* placeholder */ }
    return { path: chosen, name: basename(chosen), dirname: basename(dirname(chosen)), dir: dirname(chosen), size, mtime }
  }

  async preview(a: Automation, payload: unknown): Promise<{ prompt: string; title: string }> {
    const event = await this.sampleEvent(a, payload)
    const input = { automation: a, event }
    return { prompt: renderPrompt(input), title: renderTitle(a.target.title, input) }
  }

  /** Fire with a sample event (bypasses limits, enabled and paused). Waits up to `waitMs` for the delivery result. */
  async test(id: string, payload: unknown, waitMs = 20_000): Promise<RunRow> {
    const a = this.store.get(id)
    if (a === undefined) throw new ValidationError('unknown automation id')
    const outcome = await this.fire(a, await this.sampleEvent(a, payload))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<RunRow>((resolve) => { timer = setTimeout(() => { resolve(this.store.run(outcome.row.runId) ?? outcome.row) }, waitMs) })
    try { return await Promise.race([outcome.done, timeout]) } finally { if (timer !== undefined) clearTimeout(timer) }
  }

  draft(body: unknown): Automation {
    const reqId = typeof (body as { id?: unknown })?.id === 'string' ? (body as { id: string }).id : undefined
    return automationFrom(body, reqId === undefined ? undefined : this.store.get(reqId), this.deps.defaultCwd(), this.now()).automation
  }
}

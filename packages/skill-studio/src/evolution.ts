// Evolution wiring: proposal store, `propose_skill` tool, approve/reject routes, reviewer triggers and the automation-models source.
// The ONLY write to a skill root from this module is `applyApproved()`, reached from the user's approve route.
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { JsonStore } from './host/json-store.ts'
import { DEFAULT_CONFIG, normalizeConfig, type ApproveTarget, type EvolutionConfig } from './host/evolution-config.ts'
import { buildProposal, normalizeProposals, pendingOrThrow, ProposalError, hashContent, type EnqueueInput, type ExistingSkill, type Proposal, type ProposalState } from './host/proposals.ts'
import { createProposeSkillTool, PROPOSE_TOOL } from './host/tool.ts'
import { makeLlmCall, normalizeReview, runReview, type ReviewState, type Route, type RunLog } from './host/reviewer.ts'
import { validateSkillText } from './host/frontmatter.ts'
import { createSkill, saveSkill, WriteRefusal, type WriterOptions } from './host/writer.ts'
import { sha256, type ScanEntry } from './host/scanner.ts'

type Json = Record<string, unknown>
const ok = (value: unknown): Response => Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
const fail = (code: string, message: string, extra?: Json): Response => Response.json({ ok: false, error: { code, message, ...extra } }, { headers: { 'cache-control': 'no-store' } })

export interface EvolutionHost {
  ctx: Context
  dataDir: string
  writer: WriterOptions
  log: { info(m: string): void; warn(m: string): void }
  /** Active skills visible to DSH for a workspace (winners), with editability and ids. */
  existingSkills(cwd?: string): Promise<ExistingSkill[]>
  /** Scan entry by id (for improve). */
  entryById(id: string, cwd?: string): Promise<ScanEntry | undefined>
  /** Root directory for a create target. */
  createRoots(cwd?: string): Promise<Record<string, string>>
  sessionQuery(): { listSessions(): Promise<{ header: { id: string; cwd?: string; origin?: string; createdAt: number } }[]>; readSession(id: never): Promise<{ events: readonly never[] }> } | undefined
  usageInvalidate(): void
  /** True when DSH_HOME is not the real ~/.dsh (dev harness): approvals must never reach ~/.agents/skills. */
  isDev: boolean
}

export interface Evolution {
  /** Push channel for the badge and cards: called on every proposal / run change. */
  subscribe(listener: () => void): () => void
  summary(): { pending: number; sessions: string[]; reviewing: boolean }
  config(): EvolutionConfig
  proposals(): ProposalState
  review(): ReviewState
  route: (method: string, body: Json) => Promise<Response | undefined>
  methods: readonly string[]
  tool: ReturnType<typeof createProposeSkillTool>
  start(): void
}

export function createEvolution(host: EvolutionHost): Evolution {
  const { ctx, log } = host
  const configStore = new JsonStore<EvolutionConfig>(join(host.dataDir, 'config.json'), normalizeConfig)
  const proposalStore = new JsonStore<ProposalState>(join(host.dataDir, 'proposals.json'), normalizeProposals)
  const reviewStore = new JsonStore<ReviewState>(join(host.dataDir, 'review.json'), normalizeReview)
  const ready = Promise.all([configStore.load(), proposalStore.load(), reviewStore.load()])

  // --- model resolution: dsh-automation-models when present and it has a route for 'skill-reviewer', else our own config.
  const automation = (): { resolve?(kind: string, key?: string): { provider?: string; model?: string; reasoningEffort?: string; effort?: string } | undefined; registerSource?(kind: string, src: Json): () => void } | undefined =>
    (ctx as unknown as { get(n: string): never }).get('automationModels')
  const route = (): Route => {
    const cfg = configStore.current.reviewer
    try {
      const r = automation()?.resolve?.('skill-reviewer')
      if (r?.provider !== undefined && r.model !== undefined) return { provider: r.provider, model: r.model, ...((r.reasoningEffort ?? r.effort) === undefined ? {} : { effort: (r.reasoningEffort ?? r.effort)! }) }
    } catch { /* fall back to our own config */ }
    return { provider: cfg.provider, model: cfg.model, effort: cfg.effort }
  }

  // --- enqueue (the only way proposals are created)
  async function enqueue(input: EnqueueInput, cwd?: string): Promise<Proposal> {
    await ready
    const cfg = configStore.current
    const existing = await host.existingSkills(cwd)
    const p = await buildProposal(input, {
      state: proposalStore.current, existing, limits: { maxPending: cfg.propose.maxPending, maxPendingPerSession: cfg.propose.maxPendingPerSession },
      readTarget: async (skill) => {
        if (skill.id === undefined) return undefined
        const entry = await host.entryById(skill.id, cwd)
        if (entry === undefined || !entry.writable) return undefined // never read through a symlink that leaves its root
        const text = await readFile(entry.realPath, 'utf8')
        return { text, sha256: sha256(text) }
      },
    })
    await proposalStore.update((s) => { s.proposals.push(p) })
    notify()
    return p
  }

  const listeners = new Set<() => void>()
  const notify = (): void => { try { (ctx as unknown as { emit(n: string): void }).emit('skill-studio/proposals') } catch { /* optional */ } for (const l of listeners) l() }

  const tool = createProposeSkillTool({
    enabled: () => configStore.current.propose.enabled,
    enqueue: async (input, sessionId) => {
      const cwd = await sessionCwd(sessionId)
      const p = await enqueue(input, cwd)
      return { id: p.id, kind: p.kind, name: p.name }
    },
  })

  async function sessionCwd(sessionId: string): Promise<string | undefined> {
    try { return (await host.sessionQuery()?.listSessions())?.find(r => r.header.id === sessionId)?.header.cwd } catch { return undefined }
  }

  // --- approve: the single place that writes. Re-validates, re-checks the base hash, writes via writer.ts with backup.
  async function applyApproved(p: Proposal, text: string, cwd?: string): Promise<{ path: string; sha256: string }> {
    const v = validateSkillText(text, p.name)
    if (v.issues.some(i => i.level === 'error') || v.name !== p.name) throw new WriteRefusal('invalid', v.name !== p.name ? `The name in the frontmatter must stay "${p.name}".` : 'The edited skill has errors that would stop DSH loading it.', v.issues)
    if (p.kind === 'improve') {
      if (p.targetId === undefined || p.baseSha256 === undefined) throw new WriteRefusal('not-found', 'The proposal has no target file.')
      const entry = await host.entryById(p.targetId, cwd)
      if (entry === undefined) throw new WriteRefusal('not-found', 'The skill file this improves no longer exists.')
      const r = await saveSkill(host.writer, entry, text, p.baseSha256)
      return { path: entry.realPath, sha256: r.sha256 }
    }
    const roots = await host.createRoots(cwd)
    let target: ApproveTarget = configStore.current.approveTarget
    if (host.isDev && target === 'user-agents') { target = 'user-dsh'; log.warn('skill-studio: dev harness detected, approved skill goes to the DSH-only root instead of ~/.agents/skills') }
    const root = roots[target] ?? roots['user-dsh']
    if (root === undefined) throw new WriteRefusal('bad-target', 'No allowed skill root is available.')
    const body = text
    const created = await createSkillFromText(p.name, body, root, Object.values(roots))
    return { path: created.path, sha256: created.sha256 }
  }

  async function createSkillFromText(name: string, text: string, root: string, allowed: string[]): Promise<{ path: string; sha256: string }> {
    // createSkill renders from description/body; reuse it, then write the user's exact (possibly edited) text over the fresh file.
    const v = validateSkillText(text, name)
    const created = await createSkill({ name, description: v.description ?? name, root }, allowed)
    const { writeFile } = await import('node:fs/promises')
    const out = text.endsWith('\n') ? text : `${text}\n`
    await writeFile(created.path, out)
    return { path: created.path, sha256: sha256(out) }
  }

  async function decide(body: Json): Promise<Response> {
    await ready
    const id = typeof body.id === 'string' ? body.id : ''
    const action = body.action
    const cwd = typeof body.workspace === 'string' && body.workspace.length > 0 ? body.workspace : undefined
    let p: Proposal
    try { p = pendingOrThrow(proposalStore.current, id) } catch (e) { return e instanceof ProposalError ? fail(e.code, e.message) : fail('internal', 'failed') }
    if (action === 'reject') {
      await proposalStore.update((s) => {
        const t = s.proposals.find(x => x.id === id)
        if (t === undefined) return
        t.status = 'rejected'; t.decidedAt = Date.now()
        if (body.suppress === true) t.suppress = true
        s.ledger.push({ at: Date.now(), name: t.name, contentHash: t.contentHash, outcome: body.suppress === true ? 'suppressed' : 'rejected', kind: t.kind })
      })
      notify()
      return ok({ id, status: 'rejected' })
    }
    if (action !== 'approve') return fail('bad-request', 'action must be approve or reject')
    const edited = typeof body.text === 'string' && body.text.length > 0 && hashContent(body.text) !== p.contentHash
    const text = typeof body.text === 'string' && body.text.length > 0 ? body.text : p.content
    try {
      const written = await applyApproved(p, text, cwd)
      await proposalStore.update((s) => {
        const t = s.proposals.find(x => x.id === id)
        if (t === undefined) return
        t.status = edited ? 'edited-approved' : 'approved'; t.decidedAt = Date.now(); t.writtenPath = written.path; t.finalSha256 = written.sha256
        s.ledger.push({ at: Date.now(), name: t.name, contentHash: t.contentHash, outcome: 'approved', kind: t.kind })
      })
      host.usageInvalidate()
      notify()
      return ok({ id, status: edited ? 'edited-approved' : 'approved', path: written.path })
    } catch (error) {
      if (error instanceof WriteRefusal) {
        if (error.code === 'conflict' || error.code === 'not-found') await proposalStore.update((s) => { const t = s.proposals.find(x => x.id === id); if (t !== undefined) { t.status = 'stale'; t.failure = error.message; t.decidedAt = Date.now() } })
        notify()
        return fail(error.code, error.message, error.issues === undefined ? undefined : { issues: error.issues })
      }
      log.warn(`skill-studio: approve failed: ${error instanceof Error ? error.message : String(error)}`)
      return fail('internal', 'Could not write the skill; see the host log.')
    }
  }

  // --- reviewer
  const reader = host.sessionQuery
  const reviewerDeps = () => ({
    config: () => configStore.current.reviewer,
    route,
    listSessions: async () => ((await reader()?.listSessions()) ?? []).map(r => ({ id: String(r.header.id), ...(r.header.cwd === undefined ? {} : { cwd: r.header.cwd }), ...(r.header.origin === undefined ? {} : { origin: r.header.origin }), createdAt: r.header.createdAt })),
    readEvents: async (id: string) => { const r = reader(); if (r === undefined) throw new Error('session history unavailable'); return r.readSession(id as never) as never },
    isLive: (id: string) => { try { return (ctx as unknown as { get(n: string): { get?(i: string): unknown } | undefined }).get('agents')?.get?.(id) !== undefined } catch { return false } },
    existing: async () => (await host.existingSkills()).map(e => ({ name: e.name, description: e.description })),
    currentText: async (name: string) => {
      const s = (await host.existingSkills()).find(e => e.name === name)
      if (s?.id === undefined || s.editable === false) return undefined
      const entry = await host.entryById(s.id)
      return entry === undefined || !entry.writable ? undefined : readFile(entry.realPath, 'utf8')
    },
    enqueue: (input: EnqueueInput) => enqueue(input),
    llm: makeLlmCall(ctx as never),
    state: () => reviewStore.current,
    save: async (mutate: (s: ReviewState) => void) => { await reviewStore.update(mutate) },
    log: (m: string) => { log.info(m) },
  })

  let running: Promise<RunLog> | undefined
  const controller = new AbortController()
  function runNow(trigger: RunLog['trigger'], only?: readonly string[]): Promise<RunLog> {
    if (running !== undefined) return running
    running = ready.then(() => runReview(reviewerDeps(), trigger, only, controller.signal)).finally(() => { running = undefined; notify() })
    return running
  }

  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function scheduleIdle(sessionId: string): void {
    const cfg = configStore.current.reviewer
    if (!cfg.enabled) return
    const old = idleTimers.get(sessionId)
    if (old !== undefined) clearTimeout(old)
    const t = setTimeout(() => { idleTimers.delete(sessionId); if (configStore.current.reviewer.enabled) void runNow('idle', [sessionId]).catch(() => undefined) }, Math.round(cfg.idleMinutes * 60_000))
    t.unref?.()
    idleTimers.set(sessionId, t)
  }

  function start(): void {
    // session/event is an observe-only emit; cheap check of the event type, then (re)arm a per-session idle timer.
    ctx.on('session/event' as never, ((session: { id?: unknown }, event: { type?: string; data?: { reason?: { kind?: string } } }) => {
      if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') scheduleIdle(String(session.id))
      else if (event.type === 'turn/start') { const t = idleTimers.get(String(session.id)); if (t !== undefined) { clearTimeout(t); idleTimers.delete(String(session.id)) } }
    }) as never)
    ctx.effect(() => () => { for (const t of idleTimers.values()) clearTimeout(t); idleTimers.clear(); controller.abort(new Error('skill-studio disposed')) }, 'skill-studio: reviewer timers')
    // Daily sweep: one hourly wake-up (unref'd, no polling of anything remote) that runs when 24h passed since the last sweep.
    const hourly = setInterval(() => {
      void ready.then(() => {
        const cfg = configStore.current.reviewer
        if (cfg.enabled && cfg.dailySweep && Date.now() - reviewStore.current.lastSweepAt > 24 * 3_600_000) void runNow('sweep').catch(() => undefined)
      })
    }, 3_600_000)
    hourly.unref?.()
    ctx.effect(() => () => { clearInterval(hourly) }, 'skill-studio: daily sweep')
    // Tool: registered always; it answers "switched off" when disabled so toggling needs no restart.
    ctx.inject(['tools'], (c: Context) => {
      const tools = (c as unknown as { tools: { register(t: unknown): () => void } }).tools
      c.effect(() => tools.register(tool), `skill-studio: ${PROPOSE_TOOL}`)
    })
    // Optional: dsh-automation-models source.
    ctx.inject(['automationModels' as never], (c: Context) => {
      const am = (c as unknown as { automationModels?: { registerSource?(kind: string, src: Json): () => void } }).automationModels
      if (typeof am?.registerSource !== 'function') return
      try {
        const dispose = am.registerSource('skill-reviewer', { label: 'Skill reviewer', defaultRoute: { provider: DEFAULT_CONFIG.reviewer.provider, model: DEFAULT_CONFIG.reviewer.model, reasoningEffort: DEFAULT_CONFIG.reviewer.effort } })
        log.info('skill-studio: registered automation model source "skill-reviewer"')
        return dispose as never
      } catch (error) { log.warn(`skill-studio: automationModels.registerSource failed: ${String(error)}`) }
    })
  }

  const methods = ['proposals', 'decide', 'config', 'config-set', 'review-run', 'review-state'] as const

  async function routeFn(method: string, body: Json): Promise<Response | undefined> {
    await ready
    switch (method) {
      case 'proposals': {
        const s = proposalStore.current
        return ok({ proposals: [...s.proposals].sort((a, b) => b.createdAt - a.createdAt), pending: s.proposals.filter(p => p.status === 'pending').length, target: configStore.current.approveTarget })
      }
      case 'decide': return decide(body)
      case 'config': return ok({ config: configStore.current, route: route(), automation: automation() !== undefined, defaults: DEFAULT_CONFIG })
      case 'config-set': {
        const patch = (typeof body.config === 'object' && body.config !== null ? body.config : {}) as Json
        const merged = normalizeConfig({ ...configStore.current, ...patch, propose: { ...configStore.current.propose, ...(patch.propose as Json | undefined) }, reviewer: { ...configStore.current.reviewer, ...(patch.reviewer as Json | undefined) } })
        await configStore.update((d) => { Object.assign(d, merged) })
        return ok({ config: configStore.current })
      }
      case 'review-run': {
        let only = Array.isArray(body.sessionIds) ? body.sessionIds.filter((x): x is string => typeof x === 'string') : undefined
        // Scope a manual run to one workspace (path prefix) so the user decides whose transcripts go to the model.
        if (only === undefined && typeof body.cwdPrefix === 'string' && body.cwdPrefix.length > 0) {
          const prefix = body.cwdPrefix
          only = ((await reader()?.listSessions()) ?? []).filter(r => r.header.cwd !== undefined && (r.header.cwd === prefix || r.header.cwd.startsWith(`${prefix}/`))).map(r => String(r.header.id))
        }
        const r = await runNow('manual', only)
        return ok({ run: r })
      }
      case 'review-state': {
        const s = reviewStore.current
        return ok({ runs: [...s.runs].reverse(), tokensToday: s.tokens[new Date().toISOString().slice(0, 10)] ?? 0, running: running !== undefined, lastSweepAt: s.lastSweepAt, budget: configStore.current.reviewer.maxTokensPerDay })
      }
      default: return undefined
    }
  }

  const summary = (): { pending: number; sessions: string[]; reviewing: boolean } => {
    const list = proposalStore.current.proposals
    return { pending: list.filter(p => p.status === 'pending').length, sessions: [...new Set(list.filter(p => p.origin.sessionId !== undefined).slice(-60).map(p => p.origin.sessionId!))], reviewing: running !== undefined }
  }
  const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

  return { subscribe, summary, config: () => configStore.current, proposals: () => proposalStore.current, review: () => reviewStore.current, route: routeFn, methods, tool, start }
}

export type { ApproveTarget }

// End-of-session reviewer: picks finished sessions, condenses them (no tool outputs, redacted), asks a cheap model for candidates,
// aggregates across sessions, drafts SKILL.md for survivors and enqueues proposals. It can only call `enqueue`; it has no file access.
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { condenseSession } from './transcript.ts'
import { REVIEW_SYSTEM, DRAFT_SYSTEM, aggregate, parseCandidates, stripFence, type SessionCandidates } from './reviewer-core.ts'
import type { EvolutionConfig } from './evolution-config.ts'
import { ProposalError, type EnqueueInput } from './proposals.ts'

export interface ReviewState {
  version: 1
  /** sessionId -> last reviewed event seq. */
  cursor: Record<string, number>
  /** YYYY-MM-DD -> tokens used. */
  tokens: Record<string, number>
  runs: RunLog[]
  lastSweepAt: number
}
export interface RunLog {
  id: string; startedAt: number; finishedAt: number; trigger: 'manual' | 'idle' | 'sweep'
  route: string; sessionsConsidered: number; sessionsReviewed: number; candidates: number; proposals: number; tokens: number
  reviewed: string[]; notes: string[]; skipped: Record<string, number>; errors: string[]; status: 'ok' | 'partial' | 'failed' | 'budget'
}
export function normalizeReview(input: unknown): ReviewState {
  const r = (typeof input === 'object' && input !== null ? input : {}) as Partial<ReviewState>
  return {
    version: 1, cursor: typeof r.cursor === 'object' && r.cursor !== null ? r.cursor : {}, tokens: typeof r.tokens === 'object' && r.tokens !== null ? r.tokens : {},
    runs: Array.isArray(r.runs) ? r.runs.slice(-30) : [], lastSweepAt: typeof r.lastSweepAt === 'number' ? r.lastSweepAt : 0,
  }
}

export interface SessionRef { id: string; cwd?: string; origin?: string; createdAt: number }
export interface Route { provider: string; model: string; effort?: string }

export interface ReviewerDeps {
  config(): EvolutionConfig['reviewer']
  route(): Route
  listSessions(): Promise<SessionRef[]>
  readEvents(id: string): Promise<{ events: readonly { type?: string; seq?: number; time?: number; data?: Record<string, unknown> }[] }>
  isLive(id: string): boolean
  existing(): Promise<{ name: string; description: string }[]>
  /** Current SKILL.md text for an existing editable skill, for "improve" drafts. */
  currentText(name: string): Promise<string | undefined>
  enqueue(input: EnqueueInput): Promise<unknown>
  llm(system: string, user: string, route: Route, cfg: EvolutionConfig['reviewer'], signal: AbortSignal): Promise<{ text: string; tokens: number }>
  state(): ReviewState
  save(mutate: (s: ReviewState) => void): Promise<void>
  now?(): number
  log?(m: string): void
}

const day = (t: number): string => new Date(t).toISOString().slice(0, 10)

export async function runReview(deps: ReviewerDeps, trigger: RunLog['trigger'], only?: readonly string[], signal: AbortSignal = new AbortController().signal): Promise<RunLog> {
  const cfg = deps.config()
  const now = (deps.now ?? Date.now)()
  const route = deps.route()
  const run: RunLog = { id: `run-${String(now)}`, startedAt: now, finishedAt: now, trigger, route: `${route.provider}/${route.model}${route.effort === undefined ? '' : ` ${route.effort}`}`, sessionsConsidered: 0, sessionsReviewed: 0, candidates: 0, proposals: 0, tokens: 0, reviewed: [], notes: [], skipped: {}, errors: [], status: 'ok' }
  const skip = (why: string): void => { run.skipped[why] = (run.skipped[why] ?? 0) + 1 }
  const spentToday = (): number => deps.state().tokens[day(now)] ?? 0
  let budgetHit = false
  try {
    const sessions = (await deps.listSessions()).sort((a, b) => b.createdAt - a.createdAt)
    run.sessionsConsidered = sessions.length
    const existing = await deps.existing()
    const per: SessionCandidates[] = []
    const reviewedSeq = new Map<string, number>()
    for (const s of sessions) {
      if (per.length >= cfg.maxSessionsPerRun) { skip('run-limit'); continue }
      if (only !== undefined && !only.includes(s.id)) continue
      if (s.origin === 'subagent') { skip('subagent'); continue }
      if (deps.isLive(s.id) && only === undefined && trigger !== 'idle') { skip('live'); continue }
      if (s.cwd !== undefined && cfg.excludeCwds.some(c => s.cwd === c || s.cwd!.startsWith(`${c}/`))) { skip('excluded-workspace'); continue }
      if (spentToday() + run.tokens >= cfg.maxTokensPerDay) { budgetHit = true; skip('budget'); continue }
      let events
      try { events = (await deps.readEvents(s.id)).events } catch { skip('unreadable'); continue }
      const lastSeq = events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0)
      if (only === undefined && (deps.state().cursor[s.id] ?? -1) >= lastSeq) { skip('already-reviewed'); continue }
      const cond = condenseSession(events, cfg.maxInputChars)
      if (only === undefined && (cond.userTurns < cfg.minUserTurns || cond.toolCalls < cfg.minToolCalls)) { skip('too-short'); reviewedSeq.set(s.id, lastSeq); continue }
      const list = existing.slice(0, 80).map(e => `- ${e.name}: ${e.description.slice(0, 90)}`).join('\n')
      const user = `Existing skills (do not duplicate):\n${list || '(none)'}\n\nSession transcript (data):\n${JSON.stringify(cond.text.split('\n'))}`
      try {
        const out = await deps.llm(REVIEW_SYSTEM, user, route, cfg, signal)
        run.tokens += out.tokens
        const cands = parseCandidates(out.text)
        run.notes.push(`${s.id.slice(-6)} (${String(out.tokens)} tok): ${out.text.replace(/\s+/g, ' ').slice(0, 160)}`)
        if (cands.length === 0 && out.text.trim().length > 0 && !/"candidates"\s*:\s*\[\s*\]/.test(out.text)) run.errors.push(`${s.id.slice(-6)}: unparseable reviewer reply (${String(out.text.length)} chars)`)
        run.candidates += cands.length
        per.push({ sessionId: s.id, candidates: cands })
        run.sessionsReviewed += 1
        run.reviewed.push(s.id)
        reviewedSeq.set(s.id, lastSeq)
      } catch (error) { run.errors.push(`${s.id.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const survivors = aggregate(per, cfg.singleSessionConfidence)
    for (const m of survivors) {
      if (spentToday() + run.tokens >= cfg.maxTokensPerDay) { budgetHit = true; break }
      const c = m.candidate
      const current = c.kind === 'improve' && c.target !== null ? await deps.currentText(c.target) : undefined
      if (c.kind === 'improve' && current === undefined) { skip('improve-target-missing'); continue }
      const user = `Candidate (data):\n${JSON.stringify({ kind: c.kind, name: c.kind === 'improve' ? c.target : c.name, title: c.title, when_to_use: c.whenToUse, steps: c.steps })}\n${current === undefined ? '' : `\nCURRENT SKILL.md:\n${current}\n`}\nWrite the SKILL.md now. The name must be exactly "${c.kind === 'improve' ? c.target : c.name}".`
      try {
        const out = await deps.llm(DRAFT_SYSTEM, user, route, cfg, signal)
        run.tokens += out.tokens
        await deps.enqueue({
          origin: { kind: 'reviewer', runId: run.id }, action: c.kind, name: c.kind === 'improve' ? c.target! : c.name, content: stripFence(out.text),
          rationale: `${c.title}. ${c.whenToUse}`.trim(), evidence: m.evidenceSessions.slice(0, 4).map(e => ({ sessionId: e.sessionId, ...(e.turn === undefined ? {} : { turn: e.turn }), quote: e.why })),
        })
        run.proposals += 1
      } catch (error) {
        if (error instanceof ProposalError) skip(`rejected:${error.code}`)
        else run.errors.push(`draft ${c.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await deps.save((s) => { for (const [id, seq] of reviewedSeq) s.cursor[id] = seq })
  } catch (error) { run.errors.push(error instanceof Error ? error.message : String(error)); run.status = 'failed' }
  run.finishedAt = (deps.now ?? Date.now)()
  if (run.status !== 'failed') run.status = budgetHit ? 'budget' : run.errors.length > 0 ? 'partial' : 'ok'
  await deps.save((s) => {
    const k = day(now)
    s.tokens[k] = (s.tokens[k] ?? 0) + run.tokens
    for (const old of Object.keys(s.tokens).sort().slice(0, -14)) delete s.tokens[old]
    s.runs.push(run)
    s.runs = s.runs.slice(-30)
    if (trigger === 'sweep') s.lastSweepAt = run.finishedAt
  })
  deps.log?.(`skill-studio reviewer ${run.status}: ${String(run.sessionsReviewed)} sessions, ${String(run.proposals)} proposals, ${String(run.tokens)} tokens`)
  return run
}

/** Production LLM call: one prepared call on the chosen route, lowest effort unless configured, deadline, no session log writes. */
type LlmFace = { prepareCall(config: never, signal?: AbortSignal, configure?: never): Promise<{ config: Record<string, unknown>; stream(options: never): AsyncIterable<never> }> }

export function makeLlmCall(ctx: { get(name: string): unknown }) {
  return async (system: string, user: string, route: Route, cfg: { maxOutputTokens: number; timeoutMs: number }, signal: AbortSignal): Promise<{ text: string; tokens: number }> => {
    const llm = ctx.get('llm') as LlmFace | undefined
    if (llm === undefined) throw new Error('the LLM service is not available')
    using d = deadline(signal, cfg.timeoutMs, 'SKILL_REVIEW_TIMEOUT')
    const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: cfg.maxOutputTokens } as never, d.signal, ((controls: Record<string, unknown>, model: { reasoning?: { efforts?: { id: string }[] } }) => {
      const efforts = model.reasoning?.efforts ?? []
      const pick = route.effort !== undefined && efforts.some(e => e.id === route.effort) ? route.effort : efforts[0]?.id
      return { ...controls, ...(pick === undefined ? {} : { reasoningEffort: pick }) }
    }) as never)
    const messages = [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'dsh-skill-studio' } as never })]
    const asm = new BlockAssembler()
    const options = { ...call.config, messages, system, purpose: 'skill-review', signal: d.signal }
    for await (const chunk of call.stream(options as never)) { d.signal.throwIfAborted(); asm.push(chunk as never) }
    const finish = asm.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
    const text = asm.blocks().filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
    const usage = asm.usage
    return { text, tokens: usage === undefined ? Math.ceil((system.length + user.length + text.length) / 4) : (usage.totalTokens ?? usage.inputTokens + usage.outputTokens) }
  }
}

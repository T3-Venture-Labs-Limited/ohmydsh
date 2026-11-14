// The tracing state machine: DSH session events + the llm/stream tap -> Langfuse observations.
// One trace per turn (deterministic id), Langfuse session = root DSH session, subagent turns nest under the
// parent's tool span in the same trace. Pure with respect to Cordis: it is fed events and never touches the agent.
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import {
  type LangfuseAgent, type LangfuseGeneration, type LangfuseSpan, type LangfuseTool,
  startObservation,
} from '@langfuse/tracing'
import { type SpanContext, TraceFlags } from '@opentelemetry/api'
import type { Resolved } from './config.ts'
import { capture, environmentSecrets } from './redact.ts'
import {
  AMBIENT_SOURCES, blocksOf, costDetails, findPrice, presentMessages, safeJson, textOf, usageDetails,
  type TokenUsage,
} from './present.ts'

/** Structural views of the DSH types this file reads; keeps the module free of @deepseek-ai runtime imports. */
export interface SessionHeaderView { id: string; cwd?: string; parentSession?: string; origin?: 'subagent'; agentPreset?: string; delegationDepth?: number }
export interface SessionEventView { type: string; seq: number; time: number; data: any } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface SessionView { id: string; header: SessionHeaderView }
export interface StreamChunkView { type: string; [key: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface LlmOptionsView {
  provider: string; model: string; reasoningEffort?: string; messages?: readonly unknown[]; system?: string
  tools?: readonly { name: string }[]; sessionId?: string; purpose?: string; maxTokens?: number; temperature?: number
}

/** Pinned trace id source: the isolated provider's id generator reads it for the next root span. */
export interface TraceIdPin { next: string | undefined }

export interface TracerDeps {
  config: Resolved
  pin: TraceIdPin
  lookup: (sessionId: string) => SessionView | undefined
  now?: () => number
  onTurnEnd?: () => void
  log?: (message: string) => void
}

type AnyObs = LangfuseSpan | LangfuseAgent | LangfuseTool | LangfuseGeneration
const SPAWN_TOOL = /^(subagent|fork|spawn)/i
const HEX_SPAN = /^[0-9a-f]{16}$/

interface ToolRec { obs: LangfuseTool; name: string; ctx: SpanContext; step: number; claimedBy?: string }
interface GenRec { obs: LangfuseGeneration; startedAt: number; ended: boolean }
interface TurnState {
  n: number; seq: number; traceId: string; root: LangfuseAgent; ctx: SpanContext
  step?: { n: number; obs: LangfuseSpan }
  tools: Map<string, ToolRec>
  approvals: Map<string, { obs: LangfuseSpan; tool: string }>
  compaction?: { id: string; obs: LangfuseSpan }
  gens: Set<GenRec>
  lastText: string
  origin?: string
  injected: Set<string>
  inputSet: boolean
  startedAt: number
  hasError: boolean
}
interface SessionState {
  id: string; rootId: string; parentId: string | undefined; header: SessionHeaderView
  sampled: boolean
  turn?: TurnState
  /** Kept after the turn ends so an async child can still attach to the trace. */
  last?: { traceId: string; rootCtx: SpanContext; stepCtx?: SpanContext }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Deterministic trace id of one root-session turn: sha256("<sessionId>:<turn/start seq>")[0:32]. */
export function traceIdFor(sessionId: string, turnStartSeq: number): string {
  return sha(`${sessionId}:${turnStartSeq}`).slice(0, 32)
}

/** Stable [0,1) sample point of a trace id. */
function samplePoint(traceId: string): number {
  return parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000
}

export class Tracer {
  private readonly states = new Map<string, SessionState>()
  /** Assistant message id -> trace id (bounded), for the Open trace action. */
  private readonly messageTraces = new Map<string, string>()
  private readonly claims = new Map<string, ToolRec>()
  private readonly secrets: string[]
  private readonly now: () => number

  constructor(private readonly deps: TracerDeps) {
    this.secrets = [...environmentSecrets(), deps.config.publicKey, deps.config.secretKey]
    this.now = deps.now ?? Date.now
  }

  get config(): Resolved { return this.deps.config }

  traceIdOfMessage(messageId: string): string | undefined { return this.messageTraces.get(messageId) }

  // ---------------------------------------------------------------- session lifecycle

  private stateFor(session: SessionView): SessionState {
    let st = this.states.get(session.id)
    if (st === undefined) {
      const parentId = session.header.origin === 'subagent' ? session.header.parentSession : undefined
      const parent = parentId === undefined ? undefined : this.states.get(parentId)
      st = { id: session.id, rootId: parent?.rootId ?? session.id, parentId, header: session.header, sampled: parent?.sampled ?? true }
      this.states.set(session.id, st)
    }
    return st
  }

  /** Session left the store: end whatever is open so nothing leaks. */
  disposeSession(sessionId: string): void {
    const st = this.states.get(sessionId)
    if (st?.turn !== undefined) this.endTurn(st, st.turn, this.now(), { kind: 'disposed' })
    this.states.delete(sessionId)
  }

  shutdown(reason = 'host shutdown'): void {
    for (const st of this.states.values()) if (st.turn !== undefined) this.endTurn(st, st.turn, this.now(), { kind: 'disposed', message: reason })
    this.states.clear()
  }

  // ---------------------------------------------------------------- session/event

  onEvent(session: SessionView, event: SessionEventView): void {
    try {
      this.handle(session, event)
    } catch (error) {
      this.deps.log?.(`event ${event.type} failed: ${String(error)}`)
    }
  }

  private handle(session: SessionView, ev: SessionEventView): void {
    const st = this.stateFor(session)
    const d = ev.data
    switch (ev.type) {
      case 'turn/start': return this.startTurn(st, ev)
      case 'turn/end': return st.turn === undefined ? undefined : this.endTurn(st, st.turn, ev.time, d.reason)
      default: break
    }
    const turn = st.turn
    if (turn === undefined || !st.sampled) return
    switch (ev.type) {
      case 'step/start': return this.startStep(st, turn, d.step, ev.time)
      case 'step/end': return this.endStep(turn, ev.time)
      case 'user/message': return this.onUserMessage(st, turn, d)
      case 'assistant/message': return this.onAssistant(turn, d)
      case 'tool/call': return this.startTool(st, turn, d, ev.time)
      case 'tool/result': return this.endTool(turn, d, ev.time)
      case 'approval/asked': return this.startApproval(st, turn, d, ev.time)
      case 'approval/decided': return this.endApproval(turn, d, ev.time)
      case 'compaction/start': return this.startCompaction(st, turn, d, ev.time)
      case 'compaction/summary': return this.compactionSummary(turn, d)
      case 'compaction/end': return this.endCompaction(turn, d, ev.time)
      case 'compaction/prune': return this.compactionPrune(st, turn, d, ev.time)
      case 'llm/retry': return this.onRetry(st, turn, d, ev.time)
      default: return undefined
    }
  }

  // ---------------------------------------------------------------- turns

  private common(st: SessionState, turn: TurnState | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      dsh_session_id: st.id, root_session_id: st.rootId,
      ...(st.parentId === undefined ? {} : { parent_session_id: st.parentId, subagent: true }),
      ...(turn === undefined ? {} : { turn: turn.n }),
      ...(st.header.agentPreset === undefined ? {} : { agent_preset: st.header.agentPreset }),
      ...(st.header.cwd === undefined ? {} : { cwd: basename(st.header.cwd) }),
      ...(turn?.origin === undefined ? {} : { origin: turn.origin }),
      ...extra,
    }
  }

  private stamp(obs: AnyObs, st: SessionState, name: string): void {
    const c = this.deps.config
    obs.otelSpan.setAttributes({
      'session.id': st.rootId,
      'langfuse.trace.name': name,
      ...(c.userId === undefined ? {} : { 'user.id': c.userId }),
      ...(c.tags.length > 0 ? { 'langfuse.trace.tags': c.tags } : {}),
    })
  }

  private parentCtxForChild(st: SessionState): { ctx: SpanContext; tool?: ToolRec } | undefined {
    if (st.parentId === undefined) return undefined
    const parent = this.states.get(st.parentId)
    if (parent === undefined) return undefined
    const pt = parent.turn
    if (pt !== undefined) {
      const tool = [...pt.tools.values()].find((t) => t.claimedBy === undefined && SPAWN_TOOL.test(t.name))
      if (tool !== undefined) { tool.claimedBy = st.id; this.claims.set(st.id, tool); return { ctx: tool.ctx, tool } }
      return { ctx: pt.step?.obs.otelSpan.spanContext() ?? pt.ctx }
    }
    if (parent.last !== undefined) return { ctx: parent.last.stepCtx ?? parent.last.rootCtx }
    return undefined
  }

  private adopt(sessionId: string): SessionState | undefined {
    const view = this.deps.lookup(sessionId)
    return view === undefined ? undefined : this.stateFor(view)
  }

  private startTurn(st: SessionState, ev: SessionEventView): void {
    if (st.turn !== undefined) this.endTurn(st, st.turn, ev.time, { kind: 'interrupted' })
    const n: number = ev.data.turn
    const parentRef = this.parentCtxForChild(st)
    const parentState = st.parentId === undefined ? undefined : this.states.get(st.parentId)
    if (parentState !== undefined && !parentState.sampled) st.sampled = false
    const traceId = parentRef !== undefined ? parentRef.ctx.traceId : traceIdFor(st.id, ev.seq)
    if (parentRef === undefined) st.sampled = samplePoint(traceId) < this.deps.config.sampleRate
    if (!st.sampled) { delete st.turn; return }
    const preset = st.header.agentPreset
    const name = st.parentId === undefined ? `Turn ${n}` : `Subagent${preset === undefined ? '' : `: ${preset}`} · turn ${n}`
    if (parentRef === undefined) this.deps.pin.next = traceId
    let root: LangfuseAgent
    try {
      root = startObservation(name, { metadata: this.common(st, undefined, { turn: n, ...(st.parentId === undefined ? {} : { subagent_depth: st.header.delegationDepth ?? 1 }) }) }, {
        asType: 'agent', startTime: new Date(ev.time), ...(parentRef === undefined ? {} : { parentSpanContext: parentRef.ctx }),
      })
    } finally {
      this.deps.pin.next = undefined
    }
    this.stamp(root, st, 'DSH Turn')
    const ctx = root.otelSpan.spanContext()
    st.turn = { n, seq: ev.seq, traceId, root, ctx, tools: new Map(), approvals: new Map(), gens: new Set(), lastText: '', injected: new Set(), inputSet: false, startedAt: ev.time, hasError: false }
    st.last = { traceId, rootCtx: ctx }
  }

  private endTurn(st: SessionState, turn: TurnState, time: number, reason: { kind: string; [k: string]: any }): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const end = new Date(time)
    for (const g of turn.gens) if (!g.ended) { g.ended = true; g.obs.update({ level: 'WARNING', statusMessage: 'turn ended before the model call finished' }); g.obs.end(end) }
    for (const t of turn.tools.values()) { t.obs.update({ level: 'WARNING', statusMessage: 'turn ended before the tool returned' }); t.obs.end(end) }
    for (const a of turn.approvals.values()) a.obs.end(end)
    turn.compaction?.obs.end(end)
    turn.step?.obs.end(end)
    const failed = reason.kind === 'error'
    const cancelled = reason.kind === 'aborted'
    const output = turn.lastText === '' ? undefined : this.cap(turn.lastText)
    turn.root.update({
      ...(output === undefined ? {} : { output }),
      ...(failed ? { level: 'ERROR' as const, statusMessage: String(reason['error']?.message ?? 'turn failed') } : {}),
      ...(cancelled ? { level: 'WARNING' as const, statusMessage: `cancelled (${String(reason['reason']?.kind ?? 'unknown')})` } : {}),
      metadata: this.common(st, turn, { end_reason: reason.kind, duration_ms: time - turn.startedAt, ...(failed ? { error_code: reason['error']?.code } : {}) }),
    })
    if (output !== undefined && st.parentId === undefined) turn.root.setTraceIO({ output })
    turn.root.end(end)
    st.last = { traceId: turn.traceId, rootCtx: turn.ctx }
    delete st.turn
    this.deps.onTurnEnd?.()
  }

  private startStep(st: SessionState, turn: TurnState, n: number, time: number): void {
    turn.step?.obs.end(new Date(time))
    const obs = this.kid<LangfuseSpan>(turn.root, st, `Step ${n}`, { metadata: this.common(st, turn, { step: n }) }, 'span', time)
    turn.step = { n, obs }
    if (st.last !== undefined) st.last.stepCtx = obs.otelSpan.spanContext()
  }

  private endStep(turn: TurnState, time: number): void {
    turn.step?.obs.end(new Date(time))
    delete turn.step
  }

  private parentOf(turn: TurnState): LangfuseSpan | LangfuseAgent { return turn.step?.obs ?? turn.root }

  /** Create a child observation and stamp the Langfuse session/user on it (Langfuse reads them per observation). */
  private kid<T extends AnyObs>(parent: { startObservation: unknown }, st: SessionState, name: string, attrs: Record<string, unknown>, asType: string, time: number): T {
    const obs = (parent.startObservation as (n: string, a: unknown, o: unknown) => T)(name, attrs, { asType, startTime: new Date(time) })
    this.stampSession(obs, st)
    return obs
  }

  private stampSession(obs: AnyObs, st: SessionState): void {
    const c = this.deps.config
    obs.otelSpan.setAttributes({ 'session.id': st.rootId, ...(c.userId === undefined ? {} : { 'user.id': c.userId }) })
  }

  // ---------------------------------------------------------------- user input / origin

  private cap(value: unknown): unknown {
    const c = this.deps.config
    if (c.captureContent === 'off') return undefined
    if (c.captureContent === 'metadata') return { chars: typeof value === 'string' ? value.length : (JSON.stringify(value)?.length ?? 0) }
    return capture(value, this.secrets, c.maxChars).value
  }

  private onUserMessage(st: SessionState, turn: TurnState, d: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const kind: string = d?.source?.kind ?? 'unknown'
    if (AMBIENT_SOURCES.has(kind)) return
    if (!turn.inputSet) {
      turn.inputSet = true
      turn.origin = st.parentId === undefined ? kind : 'subagent'
      const text = textOf(d.content)
      const input = this.cap(text)
      const label = kind === 'user' ? undefined : kind
      turn.root.update({
        ...(input === undefined ? {} : { input }),
        metadata: this.common(st, turn, { origin_kind: kind, ...(d.source?.summary === undefined ? {} : { origin_summary: String(d.source.summary) }) }),
      })
      if (st.parentId === undefined && input !== undefined) turn.root.setTraceIO({ input })
      turn.root.otelSpan.setAttribute('langfuse.trace.name', label === undefined ? 'DSH Turn' : `DSH Turn (${label})`)
      turn.root.otelSpan.setAttribute('langfuse.trace.metadata.origin', turn.origin)
      const preset = st.header.agentPreset
      if (preset !== undefined) turn.root.otelSpan.setAttribute('langfuse.trace.metadata.agent_preset', preset)
    } else if (!turn.injected.has(kind)) {
      turn.injected.add(kind)
      turn.root.update({ metadata: this.common(st, turn, { injected_kinds: [...turn.injected].join(',') }) })
    }
  }

  private onAssistant(turn: TurnState, d: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const text = textOf(d.message?.content)
    if (text !== '') turn.lastText = text
    const id: string | undefined = d.message?.id
    if (id !== undefined) {
      this.messageTraces.set(id, turn.traceId)
      if (this.messageTraces.size > 20_000) this.messageTraces.delete(this.messageTraces.keys().next().value as string)
    }
  }

  // ---------------------------------------------------------------- tools / approvals

  private startTool(st: SessionState, turn: TurnState, d: any, time: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const c = this.deps.config
    const hidden = c.redactTools.includes(d.name)
    const input = hidden ? '[arguments not captured]' : this.cap(safeJson(String(d.arguments ?? '')))
    const obs = this.kid<LangfuseTool>(this.parentOf(turn), st, `Tool: ${String(d.name)}`, {
      ...(input === undefined ? {} : { input }),
      metadata: this.common(st, turn, { step: d.step, tool: d.name, call_id: d.callId }),
    }, 'tool', time)
    turn.tools.set(d.callId, { obs, name: String(d.name), ctx: obs.otelSpan.spanContext(), step: d.step })
  }

  private endTool(turn: TurnState, d: any, time: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const callId: string | undefined = d.message?.toolCallId
    const rec = callId === undefined ? undefined : turn.tools.get(callId)
    if (rec === undefined) return
    const hidden = this.deps.config.redactTools.includes(rec.name)
    const isError = d.message?.isError === true
    const text = textOf(d.message?.content)
    const output = hidden ? '[result not captured]' : this.cap(text)
    rec.obs.update({
      ...(output === undefined ? {} : { output }),
      ...(isError ? { level: 'ERROR' as const, statusMessage: String(d.error?.reason ?? d.error?.code ?? text.slice(0, 200)) } : {}),
      metadata: { result_chars: text.length, is_error: isError, ...(d.error === undefined ? {} : { error_name: d.error.name, error_code: d.error.code }) },
    })
    if (isError) turn.hasError = true
    rec.obs.end(new Date(time))
    turn.tools.delete(callId as string)
  }

  private startApproval(st: SessionState, turn: TurnState, d: any, time: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const parent = (d.callId !== undefined ? turn.tools.get(d.callId)?.obs : undefined) ?? this.parentOf(turn)
    const obs = this.kid<LangfuseSpan>(parent, st, `Approval: ${String(d.toolName)}`, {
      ...(d.reason === undefined ? {} : { input: this.cap(String(d.reason)) }),
      metadata: this.common(st, turn, { approval_id: d.id, tool: d.toolName }),
    }, 'span', time)
    turn.approvals.set(d.id, { obs, tool: String(d.toolName) })
  }

  private endApproval(turn: TurnState, d: any, time: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const a = turn.approvals.get(d.id)
    if (a === undefined) return
    a.obs.update({ output: d.outcome, ...(d.outcome === 'allowed-once' ? {} : { level: 'WARNING' as const, statusMessage: String(d.outcome) }), metadata: { outcome: d.outcome } })
    a.obs.end(new Date(time))
    turn.approvals.delete(d.id)
  }

  // ---------------------------------------------------------------- compaction / retries

  private startCompaction(st: SessionState, turn: TurnState, d: any, time: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const obs = this.kid<LangfuseSpan>(turn.root, st, 'Compaction', { metadata: this.common(st, turn, { compaction_id: d.compactionId }) }, 'span', time)
    turn.compaction = { id: String(d.compactionId), obs }
  }

  private compactionSummary(turn: TurnState, d: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (turn.compaction === undefined) return
    turn.compaction.obs.update({
      output: this.cap(textOf(d.summary)),
      metadata: { shadowed_tokens: d.shadowedTokenCount, shadowed_events: Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : undefined, summary_model: d.model, summary_provider: d.provider },
    })
  }

  private endCompaction(turn: TurnState, d: any, time: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const c = turn.compaction
    if (c === undefined) return
    if (d.error !== undefined) c.obs.update({ level: 'ERROR', statusMessage: String(d.error) })
    c.obs.end(new Date(time))
    delete turn.compaction
  }

  private compactionPrune(st: SessionState, turn: TurnState, d: any, time: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.kid(this.parentOf(turn), st, 'Compaction prune', { metadata: this.common(st, turn, { shadowed_tokens: d.shadowedTokenCount }) }, 'event', time)
  }

  private onRetry(st: SessionState, turn: TurnState, d: any, time: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.kid(this.parentOf(turn), st, `Retry #${String(d.retry)}`, {
      level: 'WARNING', statusMessage: String(d.failure?.message ?? d.failure?.code ?? 'retry'),
      metadata: this.common(st, turn, { provider: d.provider, delay_ms: d.delayMs, failure_code: d.failure?.code, failure_status: d.failure?.status, request_id: d.failure?.requestId }),
    }, 'event', time)
  }

  // ---------------------------------------------------------------- subagent lifecycle

  onSubagentStart(info: { runId: string; provider: string; parentSessionId: string; id: string }): void {
    try {
      const parent = this.states.get(info.parentSessionId)
      if (parent?.turn === undefined || !parent.sampled) return
      this.kid(this.parentOf(parent.turn), parent, 'Subagent started', { metadata: { child_session_id: info.id, run_id: info.runId, provider: info.provider } }, 'event', this.now())
    } catch (error) { this.deps.log?.(`subagent/start failed: ${String(error)}`) }
  }

  onSubagentEnd(info: { runId: string; id: string; stopReason?: string }): void {
    try {
      const tool = this.claims.get(info.id)
      tool?.obs.update({ metadata: { subagent_stop_reason: info.stopReason, subagent_run_id: info.runId, child_session_id: info.id } })
      this.claims.delete(info.id)
    } catch (error) { this.deps.log?.(`subagent/end failed: ${String(error)}`) }
  }

  // ---------------------------------------------------------------- llm/stream tap

  /** Begin one generation. Returns a recorder, or undefined when the call is not traced. */
  startGeneration(options: LlmOptionsView): GenerationRecorder | undefined {
    const c = this.deps.config
    if (options.purpose !== undefined && c.excludePurposes.includes(options.purpose)) return undefined
    const sv = options.sessionId === undefined ? undefined : (this.states.get(options.sessionId) ?? this.adopt(options.sessionId))
    const st = sv
    if (st !== undefined && !st.sampled) return undefined
    const turn = st?.turn
    const purpose = options.purpose
    let parent: { startObservation: LangfuseSpan['startObservation'] } | undefined
    if (turn !== undefined) parent = (purpose === 'compaction' ? turn.compaction?.obs : undefined) ?? this.parentOf(turn)
    const startedAt = this.now()
    const model = options.model
    const label = purpose === undefined ? `LLM: ${model}` : `LLM (${purpose}): ${model}`
    const attrs = {
      model,
      modelParameters: {
        ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      },
      input: this.generationInput(options),
      metadata: {
        ...(st === undefined ? {} : this.common(st, turn)),
        provider: options.provider, reasoning_effort: options.reasoningEffort, purpose: purpose ?? 'assistant',
        ...(turn?.step === undefined ? {} : { step: turn.step.n }),
        tool_count: options.tools?.length ?? 0,
        ...(options.tools === undefined ? {} : { tools: options.tools.map((t) => t.name).join(',') }),
        message_count: options.messages?.length ?? 0,
      },
    }
    let obs: LangfuseGeneration
    const opts = { asType: 'generation' as const, startTime: new Date(startedAt) }
    if (parent !== undefined) {
      obs = (parent.startObservation as (n: string, a: unknown, o: unknown) => LangfuseGeneration)(label, attrs, opts)
      if (st !== undefined) this.stampSession(obs, st)
    } else {
      obs = startObservation(label, attrs, opts)
      if (st !== undefined) this.stamp(obs, st, `DSH ${purpose ?? 'LLM'}`)
      else obs.otelSpan.setAttribute('langfuse.trace.name', `DSH ${purpose ?? 'LLM'}`)
    }
    const rec: GenRec = { obs, startedAt, ended: false }
    turn?.gens.add(rec)
    return new GenerationRecorder(this, rec, options, turn, this.now)
  }

  private generationInput(options: LlmOptionsView): unknown {
    const c = this.deps.config
    if (c.captureContent === 'off') return undefined
    const messages = [
      ...(options.system === undefined ? [] : [{ role: 'system', content: options.system }]),
      ...(options.messages ?? []),
    ]
    if (c.captureContent === 'metadata') return { messages: messages.length }
    return capture(presentMessages(messages, { includeReasoning: c.includeReasoning, includeSystemPrompt: c.includeSystemPrompt }), this.secrets, c.maxChars).value
  }

  /** Called by the recorder when a generation settles. */
  finishGeneration(rec: GenRec, turn: TurnState | undefined, options: LlmOptionsView, r: GenerationResult): void {
    if (rec.ended) return
    rec.ended = true
    const c = this.deps.config
    const usage = r.usage
    const output = c.captureContent === 'off' ? undefined : c.captureContent === 'metadata'
      ? { chars: r.text.length, tool_calls: r.toolCalls.length }
      : capture({
        role: 'assistant',
        ...(r.text === '' ? {} : { content: r.text }),
        ...(r.toolCalls.length > 0 ? { tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}),
        ...(c.includeReasoning && r.reasoning !== '' ? { reasoning_content: r.reasoning } : {}),
      }, this.secrets, c.maxChars).value
    const decodeMs = r.firstTokenAt === undefined ? undefined : Math.max(1, r.endedAt - r.firstTokenAt)
    const usageMap = usage === undefined ? undefined : usageDetails(usage)
    const cost = usage === undefined ? undefined : costDetails(usage, findPrice(c.pricing, options.provider, options.model))
    const bad = r.finish === 'error' || r.finish === 'aborted'
    rec.obs.update({
      ...(output === undefined ? {} : { output }),
      ...(usageMap === undefined ? {} : { usageDetails: usageMap }),
      ...(cost === undefined ? {} : { costDetails: cost }),
      ...(r.firstTokenAt === undefined ? {} : { completionStartTime: new Date(r.firstTokenAt) }),
      ...(bad ? { level: r.finish === 'error' ? ('ERROR' as const) : ('WARNING' as const), statusMessage: r.failureMessage ?? r.finish } : {}),
      metadata: {
        finish_reason: r.finish,
        latency_ms: r.endedAt - rec.startedAt,
        ...(r.firstTokenAt === undefined ? {} : { ttft_ms: r.firstTokenAt - rec.startedAt }),
        ...(decodeMs === undefined ? {} : { decode_ms: decodeMs }),
        ...(decodeMs !== undefined && usage?.outputTokens !== undefined && usage.outputTokens > 0 ? { tokens_per_s: Math.round((usage.outputTokens / decodeMs) * 10_000) / 10 } : {}),
        ...(r.failureCode === undefined ? {} : { error_code: r.failureCode }),
        ...(r.requestId === undefined ? {} : { request_id: r.requestId }),
        ...(usage?.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
        output_chars: r.text.length,
      },
    })
    if (bad && turn !== undefined) turn.hasError = true
    rec.obs.end(new Date(r.endedAt))
    turn?.gens.delete(rec)
  }

  /** Test seam: no open trace state. */
  get sessionCount(): number { return this.states.size }
  spanContextOk(ctx: SpanContext): boolean { return HEX_SPAN.test(ctx.spanId) && (ctx.traceFlags & TraceFlags.SAMPLED) !== 0 }
}

export interface GenerationResult {
  text: string; reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
  usage: TokenUsage | undefined
  firstTokenAt: number | undefined
  endedAt: number
  finish: string
  failureMessage?: string; failureCode?: string; requestId?: string
}

/** Folds the stream chunks of one model call; never throws into the caller. */
export class GenerationRecorder {
  private text = ''
  private reasoning = ''
  private readonly blocks: { id: string; name: string; arguments: string }[] = []
  private usage: TokenUsage | undefined
  private firstTokenAt: number | undefined
  private finish: StreamChunkView | undefined
  private failure: { message?: string; code?: string; requestId?: string } | undefined

  constructor(
    private readonly tracer: Tracer, private readonly rec: GenRec, private readonly options: LlmOptionsView,
    private readonly turn: TurnState | undefined, private readonly now: () => number,
  ) {}

  chunk(chunk: StreamChunkView): void {
    switch (chunk.type) {
      case 'text-delta': this.firstTokenAt ??= this.now(); this.text += String(chunk['text'] ?? ''); break
      case 'reasoning-delta': this.firstTokenAt ??= this.now(); this.reasoning += String(chunk['text'] ?? ''); break
      case 'tool-call-delta': this.firstTokenAt ??= this.now(); break
      case 'block-end': {
        const b = chunk['block']
        if (b?.type === 'tool-call') this.blocks.push({ id: String(b.id), name: String(b.name), arguments: String(b.arguments ?? '') })
        else if (b?.type === 'text' && this.text === '') this.text = String(b.text ?? '')
        else if (b?.type === 'reasoning' && this.reasoning === '') this.reasoning = String(b.text ?? '')
        break
      }
      case 'usage': this.usage = chunk['usage']; break
      case 'finish': this.finish = chunk; this.settle(); break
      default: break
    }
  }

  fail(error: unknown): void {
    const e = error as { message?: string; failure?: { code?: string; requestId?: string }; code?: string }
    this.failure = { message: e?.message ?? String(error), ...(e?.failure?.code ?? e?.code ? { code: e?.failure?.code ?? e?.code } : {}), ...(e?.failure?.requestId ? { requestId: e.failure.requestId } : {}) }
    this.settle('error')
  }

  /** Stream closed by the consumer or finished: settle once. */
  close(): void { this.settle(this.finish === undefined ? 'abandoned' : undefined) }

  private settle(forced?: string): void {
    if (this.rec.ended) return
    const reason = this.finish?.['reason']
    const failure = reason?.failure
    this.tracer.finishGeneration(this.rec, this.turn, this.options, {
      text: this.text, reasoning: this.reasoning, toolCalls: this.blocks, usage: this.usage,
      firstTokenAt: this.firstTokenAt, endedAt: this.now(),
      finish: forced ?? String(reason?.kind ?? 'stop'),
      ...(this.failure?.message ?? failure?.message ? { failureMessage: this.failure?.message ?? failure?.message } : {}),
      ...(this.failure?.code ?? failure?.code ? { failureCode: this.failure?.code ?? failure?.code } : {}),
      ...(this.failure?.requestId ?? failure?.requestId ? { requestId: this.failure?.requestId ?? failure?.requestId } : {}),
    })
  }
}

export { blocksOf }

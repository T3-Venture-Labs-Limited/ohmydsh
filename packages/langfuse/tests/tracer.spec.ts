// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { setLangfuseTracerProvider } from '@langfuse/tracing'
import type { Resolved } from '../src/host/config.ts'
import { Tracer, traceIdFor, type SessionView } from '../src/host/tracer.ts'

let exporter = new InMemorySpanExporter()
let provider: NodeTracerProvider
const config: Resolved = {
  enabled: true, baseUrl: 'http://x', environment: 'test', release: '', userId: 'u', captureContent: 'full', includeReasoning: true,
  includeSystemPrompt: true, maxChars: 100_000, sampleRate: 1, excludePurposes: ['session-title'], redactTools: ['secret_tool'], tags: [],
  pricing: { 'anthropic/haiku': { input: 1, output: 5 } }, flushTimeoutMs: 100, openTraceButton: true, publicKey: 'pk-lf-test', secretKey: 'sk-lf-test',
}
const sessions = new Map<string, SessionView>()
const view = (id: string, extra: object = {}): SessionView => { const v = { id, header: { id, ...extra } } as SessionView; sessions.set(id, v); return v }
let seq = 0
const ev = (type: string, data: unknown, time = 1000 + seq) => ({ type, seq: seq++, time, data })

function newTracer(): Tracer {
  const pin = { next: undefined as string | undefined }
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    idGenerator: { generateTraceId: () => { const p = pin.next; pin.next = undefined; return p ?? 'f'.repeat(32) }, generateSpanId: () => Math.random().toString(16).slice(2, 18).padEnd(16, '0') },
  })
  setLangfuseTracerProvider(provider)
  return new Tracer({ config, pin, lookup: (id) => sessions.get(id) })
}

const spans = () => exporter.getFinishedSpans()
const byName = (name: string) => spans().find((s) => s.name === name)
const attr = (s: any, k: string) => s?.attributes[k]

beforeEach(() => { exporter = new InMemorySpanExporter(); sessions.clear(); seq = 0 })
afterEach(async () => { await provider.shutdown(); setLangfuseTracerProvider(null) })

function runTurn(t: Tracer, s: SessionView, opts: { userKind?: string; tool?: boolean; toolError?: boolean } = {}) {
  t.onEvent(s, ev('turn/start', { turn: 1 }))
  t.onEvent(s, ev('user/message', { content: [{ type: 'text', text: 'hello Bearer abc123.def' }], source: { kind: opts.userKind ?? 'user' } }))
  t.onEvent(s, ev('step/start', { turn: 1, step: 1 }))
  const rec = t.startGeneration({ provider: 'anthropic', model: 'haiku', sessionId: s.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [{ name: 'bash' }] })
  rec?.chunk({ type: 'text-delta', index: 0, text: 'hi' })
  rec?.chunk({ type: 'usage', usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 50 } })
  rec?.chunk({ type: 'finish', reason: { kind: 'stop' } })
  t.onEvent(s, ev('assistant/message', { turn: 1, step: 1, message: { id: 'm1', content: [{ type: 'text', text: 'hi there' }] } }))
  if (opts.tool) {
    t.onEvent(s, ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }))
    t.onEvent(s, ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', isError: opts.toolError === true, content: [{ type: 'text', text: 'file.txt' }] } }))
  }
  t.onEvent(s, ev('step/end', { turn: 1, step: 1 }))
  t.onEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
}

describe('Tracer', () => {
  it('maps a turn to one trace with deterministic id, session, generation usage and TTFT', () => {
    const t = newTracer(); const s = view('sess-1')
    runTurn(t, s, { tool: true })
    const root = byName('Turn 1')!
    expect(root.spanContext().traceId).toBe(traceIdFor('sess-1', 0))
    expect(attr(root, 'session.id')).toBe('sess-1')
    expect(attr(root, 'langfuse.observation.type')).toBe('agent')
    expect(attr(root, 'langfuse.observation.input')).not.toMatch(/abc123\.def/)
    const gen = byName('LLM: haiku')!
    expect(attr(gen, 'langfuse.observation.type')).toBe('generation')
    expect(JSON.parse(attr(gen, 'langfuse.observation.usage_details'))).toEqual({ input: 100, output: 15, output_reasoning_tokens: 5, cache_read_input_tokens: 50 })
    expect(JSON.parse(attr(gen, 'langfuse.observation.cost_details')).total).toBeGreaterThan(0)
    expect(attr(gen, 'langfuse.observation.completion_start_time')).toBeTruthy()
    expect(gen.parentSpanContext?.spanId).toBe(byName('Step 1')!.spanContext().spanId)
    const tool = byName('Tool: bash')!
    expect(attr(tool, 'langfuse.observation.type')).toBe('tool')
    expect(JSON.parse(attr(tool, 'langfuse.observation.input'))).toEqual({ command: 'ls' })
    expect(new Set(spans().map((x) => x.spanContext().traceId)).size).toBe(1)
    expect(t.traceIdOfMessage('m1')).toBe(traceIdFor('sess-1', 0))
  })

  it('marks tool errors with level ERROR and records schedule origin', () => {
    const t = newTracer(); const s = view('sess-2')
    runTurn(t, s, { tool: true, toolError: true, userKind: 'schedule' })
    expect(attr(byName('Tool: bash'), 'langfuse.observation.level')).toBe('ERROR')
    const meta = attr(byName('Turn 1'), 'langfuse.observation.metadata.origin_kind')
    expect(meta).toBe('schedule')
    expect(attr(byName('Turn 1'), 'langfuse.trace.name')).toBe('DSH Turn (schedule)')
  })

  it('nests a subagent turn under the parent tool span in the same trace and root session', () => {
    const t = newTracer(); const parent = view('p-1'); const child = view('c-1', { origin: 'subagent', parentSession: 'p-1', agentPreset: 'reviewer', delegationDepth: 1 })
    t.onEvent(parent, ev('turn/start', { turn: 1 }))
    t.onEvent(parent, ev('step/start', { turn: 1, step: 1 }))
    t.onEvent(parent, ev('tool/call', { turn: 1, step: 1, callId: 'sa', name: 'subagent', arguments: '{"prompt":"x"}' }))
    t.onSubagentStart({ runId: 'r1', provider: 'spawn', parentSessionId: 'p-1', id: 'c-1' })
    t.onEvent(child, ev('turn/start', { turn: 1 }))
    t.onEvent(child, ev('user/message', { content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }))
    t.onEvent(child, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    t.onSubagentEnd({ runId: 'r1', id: 'c-1', stopReason: 'completed' })
    t.onEvent(parent, ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'sa', content: [{ type: 'text', text: 'done' }] } }))
    t.onEvent(parent, ev('step/end', { turn: 1, step: 1 }))
    t.onEvent(parent, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const tool = byName('Tool: subagent')!
    const kid = byName('Subagent: reviewer · turn 1')!
    expect(kid.parentSpanContext?.spanId).toBe(tool.spanContext().spanId)
    expect(kid.spanContext().traceId).toBe(tool.spanContext().traceId)
    expect(attr(kid, 'session.id')).toBe('p-1')
    expect(attr(kid, 'langfuse.observation.metadata.dsh_session_id')).toBe('c-1')
  })

  it('does not capture content of redacted tools and honours excluded purposes', () => {
    const t = newTracer(); const s = view('sess-3')
    t.onEvent(s, ev('turn/start', { turn: 1 }))
    t.onEvent(s, ev('tool/call', { turn: 1, step: 1, callId: 'x', name: 'secret_tool', arguments: '{"a":1}' }))
    t.onEvent(s, ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'x', content: [{ type: 'text', text: 'TOP' }] } }))
    expect(t.startGeneration({ provider: 'p', model: 'm', sessionId: 's', purpose: 'session-title' })).toBeUndefined()
    t.onEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(attr(byName('Tool: secret_tool'), 'langfuse.observation.input')).toContain('not captured')
    expect(attr(byName('Tool: secret_tool'), 'langfuse.observation.output')).toContain('not captured')
  })

  it('ends open observations on cancel and records the reason', () => {
    const t = newTracer(); const s = view('sess-4')
    t.onEvent(s, ev('turn/start', { turn: 1 }))
    t.onEvent(s, ev('step/start', { turn: 1, step: 1 }))
    t.startGeneration({ provider: 'p', model: 'm', sessionId: 'sess-4' })
    t.onEvent(s, ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    expect(attr(byName('Turn 1'), 'langfuse.observation.level')).toBe('WARNING')
    expect(spans().length).toBe(3)
  })

  it('respects sampleRate 0 for root turns', () => {
    const t = newTracer(); const s = view('sess-5'); (t as any).deps.config = { ...config, sampleRate: 0 }
    runTurn(t, s)
    expect(spans()).toHaveLength(0)
  })
})

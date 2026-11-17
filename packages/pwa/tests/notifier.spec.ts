// @vitest-environment node
// Event -> notification mapping: approval, question, plan review and reply finished notify; subagents, sessions nobody
// typed in, aborted turns, bursts and engram internals do not.
import { describe, expect, it } from 'vitest'
import { createNotifier, type EventLike, type SessionLike } from '../src/host/notifier.ts'
import type { PushPayload } from '../src/host/push.ts'

function setup(options: { throttleMs?: number; approvalGraceMs?: number } = {}) {
  const sent: PushPayload[] = []
  let clock = 1_000_000
  const timers: { fn: () => void; ms: number; live: boolean }[] = []
  const n = createNotifier({
    notify: (p) => { sent.push(p) }, now: () => clock, throttleMs: options.throttleMs ?? 8000, approvalGraceMs: options.approvalGraceMs ?? 0,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t }, clearTimer: (h) => { (h as { live: boolean }).live = false },
  })
  const session = (id: string, extra: Partial<NonNullable<SessionLike['header']>> = {}, events: EventLike[] = []): SessionLike => ({ header: { id, cwd: '/home/u/proj', ...extra }, ownEvents: () => events })
  const feed = (s: SessionLike, ...events: EventLike[]) => { for (const e of events) n.handle(s, e) }
  return { n, sent, session, feed, advance: (ms: number) => { clock += ms }, timers }
}
const human = { type: 'user/message', data: { source: { kind: 'user' }, content: [] } }
const assistant = (text: string) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text }] } } })
const end = (kind = 'completed') => ({ type: 'turn/end', data: { turn: 1, reason: { kind } } })
const start = { type: 'turn/start', data: { turn: 1 } }
const title = (t: string) => ({ type: 'session/title', data: { title: t } })

describe('reply finished', () => {
  it('notifies with the session title and the first ~120 characters of the reply', () => {
    const { sent, session, feed } = setup()
    const s = session('s1', {}, [title('Fix the login bug')])
    feed(s, start, human, assistant('Done. ' + 'word '.repeat(60)), end())
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ v: 1, kind: 'reply', title: 'Fix the login bug', sessionId: 's1' })
    expect(sent[0]!.body.length).toBeLessThanOrEqual(120); expect(sent[0]!.body.startsWith('Done. word')).toBe(true); expect(sent[0]!.body).not.toContain('hidden')
  })
  it('falls back to the directory name when there is no title', () => {
    const { sent, session, feed } = setup()
    feed(session('s1'), start, human, assistant('ok'), end())
    expect(sent[0]!.title).toBe('proj')
  })
  it('ignores aborted/error turns and turns nobody typed (schedule, trigger, goal rounds)', () => {
    const { sent, session, feed } = setup()
    const s = session('s1')
    feed(s, start, human, assistant('x'), end('aborted'), start, human, assistant('x'), end('error'))
    feed(s, start, { type: 'user/message', data: { source: { kind: 'schedule' } } }, assistant('x'), end())
    feed(s, start, { type: 'user/message', data: { source: { kind: 'composio' } } }, assistant('x'), end())
    expect(sent).toHaveLength(0)
  })
  it('ignores subagent sessions, engram/ingest sessions with no human message, and sessions without an id', () => {
    const { sent, session, feed } = setup()
    feed(session('sub', { origin: 'subagent' }), start, human, assistant('x'), end())
    feed(session('deep', { delegationDepth: 2 }), start, human, assistant('x'), end())
    feed(session('ingest'), start, { type: 'user/message', data: { source: { kind: 'plugin' } } }, assistant('x'), end())
    feed({ header: {} }, start, human, end())
    expect(sent).toHaveLength(0)
  })
  it('collapses a burst: one reply notification per session within the throttle window, independent across sessions', () => {
    const { sent, session, feed, advance } = setup()
    const a = session('a'); const b = session('b')
    feed(a, start, human, assistant('one'), end(), start, human, assistant('two'), end())
    feed(b, start, human, assistant('three'), end())
    expect(sent.map((p) => p.sessionId)).toEqual(['a', 'b'])
    advance(9000)
    feed(a, start, human, assistant('later'), end())
    expect(sent.filter((p) => p.sessionId === 'a')).toHaveLength(2)
  })
})

describe('session needs the user', () => {
  it('approval: "Approval needed" with session title and detail', () => {
    const { sent, session, feed } = setup()
    const s = session('s1', {}, [title('Deploy')])
    feed(s, human, { type: 'approval/asked', data: { id: 'ap1', toolName: 'bash', reason: 'rm -rf build' } })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'approval', title: 'Approval needed', sessionId: 's1' })
    expect(sent[0]!.body).toBe('Deploy: bash - rm -rf build')
  })
  it('an approval decided during the grace period (auto-approved) is not news', () => {
    const { sent, session, feed, timers } = setup({ approvalGraceMs: 1500 })
    const s = session('s1')
    feed(s, human, { type: 'approval/asked', data: { id: 'ap1', toolName: 'bash' } }, { type: 'approval/decided', data: { id: 'ap1', outcome: 'allowed-once' } })
    expect(timers[0]!.live).toBe(false); expect(sent).toHaveLength(0)
    feed(s, { type: 'approval/asked', data: { id: 'ap2', toolName: 'bash' } })
    expect(sent).toHaveLength(0)
    timers[1]!.fn()
    expect(sent).toHaveLength(1)
  })
  it('does not repeat the same approval id, and ignores approvals in sessions nobody typed in', () => {
    const { sent, session, feed, advance } = setup()
    const s = session('s1')
    feed(s, human, { type: 'approval/asked', data: { id: 'ap1', toolName: 'bash' } })
    advance(60_000)
    feed(s, { type: 'approval/asked', data: { id: 'ap1', toolName: 'bash' } })
    expect(sent).toHaveLength(1)
    feed(session('auto'), { type: 'approval/asked', data: { id: 'x', toolName: 'bash' } })
    expect(sent).toHaveLength(1)
  })
  it('question and plan review', () => {
    const { sent, session, feed } = setup()
    const s = session('s1', {}, [title('Design')])
    feed(s, human,
      { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Which database should we use?' }] }) } },
      { type: 'tool/call', data: { callId: 'c2', name: 'exit_plan_mode', arguments: '{}' } },
      { type: 'tool/call', data: { callId: 'c3', name: 'read_file', arguments: '{}' } })
    expect(sent.map((p) => [p.kind, p.title])).toEqual([['question', 'Question for you'], ['plan', 'Plan ready for review']])
    expect(sent[0]!.body).toBe('Design: Which database should we use?')
  })
  it('subagent approvals and questions never notify', () => {
    const { sent, session, feed } = setup()
    const s = session('sub', { origin: 'subagent' })
    feed(s, human, { type: 'approval/asked', data: { id: 'a', toolName: 'bash' } }, { type: 'tool/call', data: { callId: 'c', name: 'ask_user_question', arguments: '{}' } })
    expect(sent).toHaveLength(0)
  })
  it('a session resumed after a restart still counts as person-driven when its log has a human message', () => {
    const { sent, session, feed } = setup()
    feed(session('s1', {}, [human as never]), { type: 'approval/asked', data: { id: 'a', toolName: 'bash' } })
    expect(sent).toHaveLength(1)
  })
})

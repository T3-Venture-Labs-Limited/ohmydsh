import { basename } from 'node:path'
import { clip, type PushPayload } from './push.ts'

/** The slice of a DSH session this module reads. */
export interface SessionLike {
  readonly header?: { readonly id?: string; readonly cwd?: string; readonly origin?: string; readonly delegationDepth?: number }
  ownEvents?(): readonly { readonly type: string; readonly data?: unknown }[]
}
export interface EventLike { readonly type: string; readonly data?: unknown }

export interface NotifierOptions {
  /** Called with each notification that survived filtering and collapsing. */
  readonly notify: (payload: PushPayload) => void | Promise<unknown>
  readonly now?: () => number
  /** Minimum gap between two notifications of the same kind for one session. */
  readonly throttleMs?: number
  /** Hold an approval this long and drop it if it is decided meanwhile (auto-approved asks are not news). */
  readonly approvalGraceMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

interface SessionState {
  /** A person-authored message was seen in this session (sticky): approvals/questions only matter for sessions a person drives. */
  everHuman: boolean
  /** The current turn was started by a person's message. */
  turnHuman: boolean
  lastReply: string
  lastAt: Map<string, number>
  seen: Set<string>
}

const CACHE_LIMIT = 300
const HUMAN_SOURCES = new Set(['user', 'user-question-reply'])
const QUESTION_TOOL = 'ask_user_question'
const PLAN_TOOL = 'exit_plan_mode'

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' ? value as Record<string, unknown> : {})

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((part) => { const p = asRecord(part); return p['type'] === 'text' && typeof p['text'] === 'string' ? p['text'] : '' }).filter(Boolean).join('\n').trim()
}

/**
 * Maps the host's session event feed to notifications (same events as dsh-notify-me's host fallback):
 *  - `approval/asked`, a pending `ask_user_question` or `exit_plan_mode` call  -> the session needs the person
 *  - `turn/end` (completed) of a turn the person started                       -> the reply is ready
 * Subagent sessions and turns nobody typed (schedules, triggers, goal rounds) are ignored. Per session and kind, a
 * burst collapses to one notification, and the client replaces older ones by using the session id as the tag.
 */
export function createNotifier(options: NotifierOptions) {
  const now = options.now ?? Date.now
  const throttleMs = options.throttleMs ?? 8000
  const graceMs = options.approvalGraceMs ?? 1500
  const setTimer = options.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h })
  const clearTimer = options.clearTimer ?? ((h) => { clearTimeout(h as ReturnType<typeof setTimeout>) })
  const states = new Map<string, SessionState>()
  const pendingApprovals = new Map<string, unknown>()

  /** A session resumed after a host restart: its log already says whether a person ever wrote in it. */
  const everHumanIn = (session: SessionLike): boolean => {
    try {
      return (session.ownEvents?.() ?? []).some((e) => e.type === 'user/message' && HUMAN_SOURCES.has(String(asRecord(asRecord(e.data)['source'])['kind'])))
    } catch { return false }
  }

  const stateOf = (id: string, session: SessionLike): SessionState => {
    let state = states.get(id)
    if (state === undefined) {
      state = { everHuman: everHumanIn(session), turnHuman: false, lastReply: '', lastAt: new Map(), seen: new Set() }
      states.set(id, state)
      if (states.size > CACHE_LIMIT) states.delete(states.keys().next().value as string)
    }
    return state
  }

  const titleOf = (session: SessionLike, id: string): string => {
    try {
      const events = session.ownEvents?.() ?? []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type === 'session/title') {
          const title = asRecord(event.data)['title']
          if (typeof title === 'string' && title.trim() !== '') return clip(title, 60)
        }
      }
    } catch { /* fall through */ }
    const cwd = session.header?.cwd
    return cwd !== undefined && cwd !== '' ? basename(cwd) : `Session ${id.slice(0, 8)}`
  }

  const emit = (state: SessionState, payload: PushPayload): void => {
    const last = state.lastAt.get(payload.kind) ?? Number.NEGATIVE_INFINITY
    const at = now()
    if (at - last < throttleMs) return
    state.lastAt.set(payload.kind, at)
    void Promise.resolve(options.notify(payload)).catch(() => {})
  }

  const once = (state: SessionState, key: string): boolean => {
    if (state.seen.has(key)) return false
    state.seen.add(key)
    if (state.seen.size > 200) state.seen.delete(state.seen.values().next().value as string)
    return true
  }

  function handle(session: SessionLike, event: EventLike): void {
    const header = session.header
    const id = header?.id
    if (typeof id !== 'string' || id === '') return
    if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) return
    const state = stateOf(id, session)
    const data = asRecord(event.data)

    switch (event.type) {
      case 'turn/start':
        state.turnHuman = false
        state.lastReply = ''
        return
      case 'user/message': {
        const kind = asRecord(data['source'])['kind']
        if (typeof kind === 'string' && HUMAN_SOURCES.has(kind)) { state.everHuman = true; state.turnHuman = true }
        return
      }
      case 'assistant/message': {
        const text = textOf(asRecord(data['message'])['content'])
        if (text !== '') state.lastReply = text
        return
      }
      case 'approval/asked': {
        if (!state.everHuman) return
        const askId = typeof data['id'] === 'string' ? data['id'] : ''
        if (askId !== '' && !once(state, `approval:${askId}`)) return
        const tool = typeof data['toolName'] === 'string' && data['toolName'] !== '' ? data['toolName'] : 'a tool'
        const reason = typeof data['reason'] === 'string' ? data['reason'] : ''
        const send = (): void => {
          pendingApprovals.delete(askId)
          emit(state, { v: 1, kind: 'approval', title: 'Approval needed', body: `${titleOf(session, id)}: ${tool}${reason !== '' ? ` - ${clip(reason, 100)}` : ''}`, sessionId: id })
        }
        if (graceMs <= 0 || askId === '') send()
        else pendingApprovals.set(askId, setTimer(send, graceMs))
        return
      }
      case 'approval/decided': {
        const askId = typeof data['id'] === 'string' ? data['id'] : ''
        const timer = pendingApprovals.get(askId)
        if (timer !== undefined) { clearTimer(timer); pendingApprovals.delete(askId) }
        return
      }
      case 'tool/call': {
        const name = data['name']
        if (name !== QUESTION_TOOL && name !== PLAN_TOOL) return
        if (!state.everHuman) return
        const callId = typeof data['callId'] === 'string' ? data['callId'] : ''
        if (callId !== '' && !once(state, `call:${callId}`)) return
        if (name === PLAN_TOOL) {
          emit(state, { v: 1, kind: 'plan', title: 'Plan ready for review', body: titleOf(session, id), sessionId: id })
          return
        }
        let question = ''
        try {
          const first = asRecord((asRecord(JSON.parse(String(data['arguments'] ?? '{}')))['questions'] as unknown[] | undefined)?.[0])
          question = typeof first['question'] === 'string' ? first['question'] : ''
        } catch { /* arguments were not JSON: no detail */ }
        emit(state, { v: 1, kind: 'question', title: 'Question for you', body: `${titleOf(session, id)}${question !== '' ? `: ${clip(question, 100)}` : ''}`, sessionId: id })
        return
      }
      case 'turn/end': {
        const reason = asRecord(data['reason'])['kind']
        const human = state.turnHuman
        const reply = state.lastReply
        state.turnHuman = false
        state.lastReply = ''
        if (!human || reason !== 'completed') return
        emit(state, { v: 1, kind: 'reply', title: titleOf(session, id), body: reply !== '' ? clip(reply, 120) : 'Reply finished', sessionId: id })
        return
      }
    }
  }

  return {
    handle,
    forget(session: SessionLike): void {
      const id = session.header?.id
      if (typeof id === 'string') states.delete(id)
    },
    dispose(): void {
      for (const timer of pendingApprovals.values()) clearTimer(timer)
      pendingApprovals.clear()
    },
  }
}
export type Notifier = ReturnType<typeof createNotifier>

// Chat transcript adapter: settled assistant steps and user bubbles carry `data-text-interaction-source`.
import type { Capture, ReviewComment } from '../types.ts'
import { anchorOfSlice, cleanQuote, elementOf, NON_QUOTE, project, sliceOfRange, textNodesOf } from '../text.ts'

export const SOURCE = '[data-text-interaction-source]'
const PROCESS = '[data-variant="think"], [data-chat-group-part="reasoning"], [data-chat-flow-kind="tool-call"], [data-chat-flow-kind="tool-result"], [data-chat-flow-kind="turn-process"], [data-turn-process-hidden]'

export interface ChatHit { body: HTMLElement; node: HTMLElement; nodeKey: string; turn: string | undefined; sessionId: string; role: 'assistant' | 'user'; conversation: HTMLElement | null }

export function chatHitOf(node: Node, fallbackSession: string): ChatHit | null {
  const el = elementOf(node)
  if (el === null || el.closest(PROCESS) !== null) return null
  const body = el.closest<HTMLElement>(SOURCE)
  if (body === null) return null
  const holder = body.closest<HTMLElement>('[data-chat-node-key]')
  const nodeKey = holder?.dataset.chatNodeKey
  if (holder === null || nodeKey === undefined) return null
  const kind = holder.dataset.chatFlowKind ?? ''
  const conversation = body.closest<HTMLElement>('[data-conversation-session]')
  const sessionId = conversation?.dataset.conversationSession ?? fallbackSession
  if (sessionId === '') return null
  return { body, node: holder, nodeKey, turn: holder.dataset.chatTurn, sessionId, role: kind.startsWith('assistant') ? 'assistant' : 'user', conversation }
}

export function captureChat(selection: Selection, fallbackSession: string): Capture | null {
  if (selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const start = chatHitOf(range.startContainer, fallbackSession)
  const end = chatHitOf(range.endContainer, fallbackSession)
  if (start === null || end === null || start.body !== end.body) return null
  if (start.body.querySelector('[data-streaming]') !== null || start.body.hasAttribute('data-streaming')) return null
  if (elementOf(range.commonAncestorContainer)?.closest(NON_QUOTE)) return null
  const nodes = textNodesOf(start.body)
  const p = project(nodes)
  const slice = sliceOfRange(p, range)
  if (slice === null) return null
  const ta = anchorOfSlice(p, slice.start, slice.end)
  if (ta.find.trim() === '') return null
  const browser = cleanQuote(selection.toString())
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const quote = browser !== '' && norm(browser) === norm(ta.find) ? browser : cleanQuote(ta.find)
  return {
    sessionId: start.sessionId,
    target: { kind: 'message', role: start.role },
    anchor: { kind: 'message', nodeKey: start.nodeKey, ...(start.turn !== undefined ? { turn: start.turn } : {}) },
    quote, ...ta, range: range.cloneRange(), viewer: start.conversation ?? start.body,
  }
}

export function chatBodiesFor(comment: ReviewComment, root: ParentNode = document): HTMLElement[] {
  if (comment.anchor.kind !== 'message') return []
  const key = comment.anchor.nodeKey
  const out: HTMLElement[] = []
  for (const holder of root.querySelectorAll<HTMLElement>('[data-chat-node-key]')) {
    if (holder.dataset.chatNodeKey !== key) continue
    const conversation = holder.closest<HTMLElement>('[data-conversation-session]')
    if (conversation !== null && conversation.dataset.conversationSession !== comment.sessionId) continue
    for (const body of holder.querySelectorAll<HTMLElement>(SOURCE)) out.push(body)
  }
  return out
}

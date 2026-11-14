import type { InputActionsLike } from './host.ts'
import { chipSummary, chipText } from './format.ts'
import type { CommentStore } from './store.ts'
import type { ReviewComment } from './types.ts'

export interface SendResult { inserted: number; blocked: boolean }

/**
 * Put each comment into the composer as its own removable quote chip, in order, and mark it sent.
 * `insertQuote` refuses outside the plain composer phase (e.g. while a message is submitting); we stop at the first
 * refusal and keep the rest open so nothing is lost.
 */
export function sendToComposer(store: CommentStore, sessionId: string, input: InputActionsLike, comments: readonly ReviewComment[]): SendResult {
  const sent: string[] = []
  let blocked = false
  for (const comment of comments) {
    let accepted = false
    try { accepted = input.insertQuote(chipText(comment), chipSummary(comment)) } catch { accepted = false }
    if (!accepted) { blocked = true; break }
    sent.push(comment.id)
  }
  if (sent.length > 0) store.setStatus(sessionId, sent, 'sent')
  return { inserted: sent.length, blocked }
}

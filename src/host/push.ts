// Live channel: a Typert stream (`dshReviewComments/changes`) on DSH's shared Remote WebSocket. It yields `{ sessionId }`
// whenever a session's comments change on the Host (an agent resolved one). No HTTP stream: that would hold one of the
// browser's 6 connections per host for the life of the page.
import { pushIterable, registerPushRemote } from '../kit/push/host.ts'
import type { PushHostCtx } from '../kit/push/host.ts'
import type { HostStore } from './store.ts'

export const REMOTE_NAMESPACE = 'dshReviewComments'
export const REMOTE_PACKAGE = 'dsh-review-comments'
export const STREAM_METHOD = 'changes'

export function changesStream(store: HostStore, signal: AbortSignal | undefined): AsyncGenerator<{ sessionId: string }, void, void> {
  return pushIterable((emit) => store.subscribe((sessionId) => { emit({ sessionId }) }), signal)
}

export function registerReviewRemote(ctx: PushHostCtx, store: HostStore): () => void {
  return registerPushRemote({
    ctx, serviceKey: REMOTE_NAMESPACE, namespace: REMOTE_NAMESPACE,
    // The gateway reads the wire fields off this signature: no fields, only the injected `signal`.
    streams: [{ method: STREAM_METHOD, implementation: function changes(signal: AbortSignal) { return changesStream(store, signal) } as never }],
  })
}

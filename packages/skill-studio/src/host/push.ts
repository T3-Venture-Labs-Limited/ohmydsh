// Live channel: a Typert stream (`dshSkillStudio/summary`) on DSH's shared Remote WebSocket. It yields the pending-proposal
// summary first, then again on every change. No HTTP stream: that would hold one of the browser's 6 connections per host
// for the life of the page.
import { pushIterable, registerPushRemote } from '../kit/push/host.ts'
import type { PushHostCtx } from '../kit/push/host.ts'

export const REMOTE_NAMESPACE = 'dshSkillStudio'
export const REMOTE_PACKAGE = 'dsh-skill-studio'
export const STREAM_METHOD = 'summary'

export interface SummaryFace<S> { summary(): S; subscribe(listener: () => void): () => void }

export function summaryStream<S>(evolution: SummaryFace<S>, signal: AbortSignal | undefined): AsyncGenerator<S, void, void> {
  return pushIterable<S>((emit) => evolution.subscribe(() => { emit(evolution.summary()) }), signal, () => [evolution.summary()])
}

export function registerSkillRemote<S>(ctx: PushHostCtx, evolution: SummaryFace<S>): () => void {
  return registerPushRemote({
    ctx, serviceKey: REMOTE_NAMESPACE, namespace: REMOTE_NAMESPACE,
    // The gateway reads the wire fields off this signature: no fields, only the injected `signal`.
    streams: [{ method: STREAM_METHOD, implementation: function summary(signal: AbortSignal) { return summaryStream(evolution, signal) } as never }],
  })
}

// Live channel: one Typert stream (`dshTheme/omarchy`) on DSH's shared Remote WebSocket. It yields the current palette
// first, then every change. No HTTP stream, so it never uses one of the browser's 6 connections per host.
import { pushIterable, registerPushRemote } from '../kit/push/host.ts'
import type { PushHostCtx } from '../kit/push/host.ts'
import type { OmarchyState } from './omarchy-state.ts'
import { wireOf } from './routes.ts'

export const REMOTE_NAMESPACE = 'dshTheme'
export const REMOTE_PACKAGE = '@t3labs/ohmydsh-theme'
export const STREAM_METHOD = 'omarchy'

export function omarchyStream(state: OmarchyState, signal: AbortSignal | undefined): AsyncGenerator<ReturnType<typeof wireOf>, void, void> {
  return pushIterable((emit) => state.subscribe((snapshot) => { emit(wireOf(snapshot)) }), signal, () => [wireOf(state.current())])
}

export function registerThemeRemote(ctx: PushHostCtx, state: OmarchyState): () => void {
  return registerPushRemote({
    ctx, serviceKey: REMOTE_NAMESPACE, namespace: REMOTE_NAMESPACE,
    // The gateway reads the wire fields off this signature: no fields, only the injected `signal`.
    streams: [{ method: STREAM_METHOD, implementation: function omarchy(signal: AbortSignal) { return omarchyStream(state, signal) } as never }],
  })
}

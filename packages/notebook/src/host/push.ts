// Live channel: a Typert stream (`dshNotebook/events`) per open notebook on DSH's shared Remote WebSocket. It yields a full
// snapshot first, then every incremental event. No HTTP stream: each one would hold one of the browser's 6 connections per
// host for as long as the notebook tab exists.
import type { Context } from '@deepseek-ai/cordis'
import type { NotebookEvent } from '../core/types.ts'
import { pushIterable, registerPushRemote } from '../kit/push/host.ts'
import type { PushHostCtx } from '../kit/push/host.ts'
import { NotebookError } from './document.ts'
import { scopeOfSession } from './scope.ts'
import type { NotebookService } from './service.ts'

export const REMOTE_NAMESPACE = 'dshNotebook'
export const REMOTE_PACKAGE = '@t3labs/ohmydsh-notebook'
export const STREAM_METHOD = 'events'

/** Same scope and path rules as the RPC route: the session decides the workspace, the path must stay inside it. */
export async function* notebookEvents(ctx: Context, service: NotebookService, sessionId: string, path: string, signal: AbortSignal | undefined): AsyncGenerator<NotebookEvent, void, void> {
  if (typeof sessionId !== 'string' || typeof path !== 'string') throw new NotebookError('bad-request', 'sessionId and path are required.')
  const scope = await scopeOfSession(ctx, sessionId)
  const doc = await service.open(scope, path)
  yield* pushIterable<NotebookEvent>((emit) => doc.subscribe(emit), signal, () => [{ t: 'snap', nb: doc.snapshot(scope) }])
}

export function registerNotebookRemote(ctx: Context, service: NotebookService): () => void {
  return registerPushRemote({
    ctx: ctx as unknown as PushHostCtx, serviceKey: REMOTE_NAMESPACE, namespace: REMOTE_NAMESPACE,
    // The gateway reads the wire fields off this signature, in order, then injects `signal`.
    streams: [{ method: STREAM_METHOD, implementation: function events(sessionId: string, path: string, signal: AbortSignal) { return notebookEvents(ctx, service, sessionId, path, signal) } as never }],
  })
}

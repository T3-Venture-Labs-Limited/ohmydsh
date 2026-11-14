// Live channel: a Typert stream (`dshStudio/jobs`) on DSH's shared Remote WebSocket. It yields a snapshot of the active jobs
// first, then one `job` item per job change and one `asset` item per new asset. No HTTP stream: that would hold one of the
// browser's 6 connections per host for as long as the Studio tab is open.
import { pushIterable, registerPushRemote } from '../kit/push/host.js'
import type { PushHostCtx } from '../kit/push/host.js'
import type { StudioCore } from './core.js'
import { jobView } from './routes/jobs.js'

export const REMOTE_NAMESPACE = 'dshStudio'
export const REMOTE_PACKAGE = 'dsh-studio'
export const STREAM_METHOD = 'jobs'
const ACTIVE = ['queued', 'submitting', 'running', 'finalizing', 'needs_attention'] as const

export type JobsFrame =
  | { event: 'snapshot'; data: { jobs: ReturnType<typeof jobView>[] } }
  | { event: 'job'; data: ReturnType<typeof jobView> }
  | { event: 'asset'; data: unknown }

export function jobsStream(core: Pick<StudioCore, 'db' | 'runner' | 'assets'>, signal: AbortSignal | undefined): AsyncGenerator<JobsFrame, void, void> {
  return pushIterable<JobsFrame>((emit) => {
    const offJob = core.runner.onJob((job) => { emit({ event: 'job', data: jobView(job) }) })
    const offAsset = core.assets.onAsset((asset) => { emit({ event: 'asset', data: asset }) })
    return () => { offJob(); offAsset() }
  }, signal, () => [{ event: 'snapshot', data: { jobs: core.db.listJobs({ states: [...ACTIVE], limit: 100 }).map(jobView) } }])
}

export function registerStudioRemote(ctx: PushHostCtx, core: Pick<StudioCore, 'db' | 'runner' | 'assets'>): () => void {
  return registerPushRemote({
    ctx, serviceKey: REMOTE_NAMESPACE, namespace: REMOTE_NAMESPACE,
    // The gateway reads the wire fields off this signature: no fields, only the injected `signal`.
    streams: [{ method: STREAM_METHOD, implementation: function jobs(signal: AbortSignal) { return jobsStream(core, signal) } as never }],
  })
}

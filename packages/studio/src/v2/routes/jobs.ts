/** Job routes: submit, list, get, cancel, retry. The live channel is a Typert stream (../push.ts), not an HTTP stream. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AdapterError, type JobRecord } from '../contracts.js'
import type { StudioCore } from '../core.js'
import { HttpError, fail, json, readJson, sameOrigin, url } from './http.js'
import { parseOperationRequest } from '../request.js'

/** Compact view for lists and SSE: never includes the full request body (it can contain large params). */
export function jobView(job: JobRecord) {
  return {
    id: job.id, state: job.state, op: job.op, modelId: job.modelId, provider: job.provider, createdAt: job.createdAt, updatedAt: job.updatedAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }), ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.progress === undefined ? {} : { progress: job.progress }), ...(job.message === undefined ? {} : { message: job.message }), ...(job.error === undefined ? {} : { error: job.error }),
    assetIds: job.assetIds, origin: job.origin, prompt: job.request.prompt ?? '', ...(job.estimateUsd === undefined ? {} : { estimateUsd: job.estimateUsd }),
    ...(job.costUsd === undefined ? {} : { costUsd: job.costUsd, costSource: job.costSource }), attempt: job.attempt,
  }
}

export async function serveJobApi(core: StudioCore, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) return fail(res, 403, 'origin-rejected')
  try {
    if (path === '/jobs' && method === 'GET') {
      const p = url(req).searchParams
      const states = p.get('state')?.split(',').filter(Boolean) as JobRecord['state'][] | undefined
      return json(res, 200, { jobs: core.db.listJobs({ ...(states === undefined ? {} : { states }), limit: Number(p.get('limit') ?? 100) }).map(jobView) })
    }
    if (path === '/estimate' && method === 'POST') {
      const request = parseOperationRequest(await readJson(req), 'ui')
      return json(res, 200, await core.runner.preview(request))
    }
    if (path === '/jobs' && method === 'POST') {
      const request = parseOperationRequest(await readJson(req), 'ui')
      const job = await core.runner.submit(request)
      return json(res, 202, { job: jobView(job) })
    }
    const m = /^\/jobs\/([^/]+)(?:\/(cancel|retry))?$/.exec(path)
    if (m !== null) {
      const id = m[1]!; const action = m[2]
      const job = core.db.getJob(id)
      if (job === undefined) return fail(res, 404, 'not-found')
      if (action === undefined && method === 'GET') return json(res, 200, { job: jobView(job), request: job.request })
      if (action === 'cancel' && method === 'POST') return json(res, 200, { job: jobView((await core.runner.cancel(id)) ?? job) })
      if (action === 'retry' && method === 'POST') return json(res, 202, { job: jobView(await core.runner.retry(id)) })
    }
    return fail(res, 404, 'not-found')
  } catch (error) { return replyError(res, error) }
}

export function replyError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) return fail(res, error.status, error.code)
  if (error instanceof AdapterError) {
    const status = error.kind === 'invalid' || error.kind === 'unsupported' ? 400 : error.kind === 'auth' ? 401 : error.kind === 'quota' ? 402 : 502
    return fail(res, status, error.kind, error.message)
  }
  return fail(res, 500, 'server-error', error instanceof Error ? error.message : String(error))
}

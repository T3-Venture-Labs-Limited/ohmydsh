/** Model catalog + provider status routes. Never returns keys, only whether each provider is configured. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROVIDER_INFO, type Capability, type ProviderId } from '../contracts.js'
import type { StudioCore } from '../core.js'
import { fail, json, url } from './http.js'
import { fetchModelExamples } from '../providers/replicate.js'
import { replyError } from './jobs.js'

export async function serveModelApi(core: StudioCore, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method !== 'GET') return fail(res, 405, 'method-not-allowed')
  try {
    if (path === '/models') {
      const p = url(req).searchParams
      const models = await core.registry.listModels({
        ...(p.get('capability') === null ? {} : { capability: p.get('capability') as Capability }), ...(p.get('provider') === null ? {} : { provider: p.get('provider') as ProviderId }),
        configuredOnly: p.get('configured') === '1', refresh: p.get('refresh') === '1',
      })
      return json(res, 200, { models })
    }
    if (path === '/models/examples') {
      const modelId = url(req).searchParams.get('modelId') ?? ''
      if (!modelId.startsWith('replicate:')) return json(res, 200, { available: false, examples: [] })
      const slug = modelId.slice('replicate:'.length)
      const cached = core.db.getCache(`examples:${slug}`)
      if (cached !== undefined && Date.now() - cached.fetchedAt < 3_600_000) return json(res, 200, JSON.parse(cached.payload))
      const result = await fetchModelExamples({ apiToken: () => core.keys?.('REPLICATE_API_TOKEN') ?? Promise.resolve(undefined) }, slug)
      if (result.available) core.db.putCache(`examples:${slug}`, JSON.stringify(result), Date.now())
      return json(res, 200, result)
    }
    if (path === '/providers') {
      const configured = new Set(await core.registry.configuredProviders())
      return json(res, 200, { providers: core.registry.providers().map(a => ({ id: a.id, configured: configured.has(a.id), ...(a.id in PROVIDER_INFO ? PROVIDER_INFO[a.id as keyof typeof PROVIDER_INFO] : {}) })) })
    }
    return fail(res, 404, 'not-found')
  } catch (error) { return replyError(res, error) }
}

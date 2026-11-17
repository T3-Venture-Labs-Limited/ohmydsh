/** Single prefix route for the v2 API, mounted at /plugins/dsh-studio/v2 behind connection admission. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StudioCore } from '../core.js'
import { ROUTE_BASE, fail } from './http.js'
import { serveAssetApi } from './assets.js'
import { serveJobApi } from './jobs.js'
import { serveModelApi } from './models.js'
import { serveHyperframesApi } from './hyperframes.js'
import { serveSettingsApi } from './settings.js'
import { serveLegacyApi } from './legacy.js'
import { serveAgentMediaApi, type AgentMediaApi } from './agent-media.js'
import type { LegacyDeps } from '../legacy-import.js'
import type { HyperframesManager } from '../hyperframes/launcher.js'

export { ROUTE_BASE }

export function createV2Handler(core: StudioCore, hf?: HyperframesManager, legacy?: LegacyDeps, agent?: AgentMediaApi): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const full = (req.url ?? '/').split('?')[0]!
    const path = full.startsWith(ROUTE_BASE) ? full.slice(ROUTE_BASE.length) || '/' : full
    if (path.startsWith('/assets') || path === '/masks' || path === '/tags' || path === '/collections' || path === '/spend' || path === '/stats') return serveAssetApi(core, req, res, path, agent)
    if (path === '/agent-media' || path.startsWith('/agent-media/')) return serveAgentMediaApi(core, agent, req, res, path)
    if (path === '/import-legacy' || path.startsWith('/import-legacy/')) return serveLegacyApi(core, legacy, req, res, path)
    if (path === '/settings') return serveSettingsApi(core, req, res)
    if (path.startsWith('/hyperframes/')) return hf === undefined ? fail(res, 503, 'hyperframes-disabled') : serveHyperframesApi(hf, req, res, path)
    if (path.startsWith('/jobs') || path === '/estimate') return serveJobApi(core, req, res, path)
    if (path === '/models' || path === '/models/examples' || path === '/providers') return serveModelApi(core, req, res, path)
    return fail(res, 404, 'not-found')
  }
}

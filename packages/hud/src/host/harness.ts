/**
 * The single boundary between this plugin and DSH internals (pattern from dsh-quorfloat's adapter, MIT, see NOTICE).
 * Only what the HUD needs: list, create, follow, prompt, cancel, model options/selection, web URL.
 * Model selection is per session through `agent.model.select()`; `sessionController.selectModel` is never used
 * because it rewrites the profile's global default model.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'

type Json = Record<string, unknown>
const rec = (v: unknown): Json => (typeof v === 'object' && v !== null ? v as Json : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

export class GuardError extends Error {}

/** Drop userinfo, query and fragment: only the origin + path of the advertised URL is handed out. */
export function stripCredentials(raw: string): string {
  try {
    const u = new URL(raw)
    u.username = ''; u.password = ''; u.search = ''; u.hash = ''
    return u.toString()
  } catch { return raw.split(/[?#]/)[0] ?? raw }
}

export interface SessionRow { sessionId: string; title?: string; cwd?: string; updatedAt: number; running: boolean; blank: boolean }
export interface WorkspaceRow { workspaceId: string; title: string; path: string }
export interface ModelChoice { provider: string; model: string; reasoningEffort?: string }
export interface ModelGroup { provider: string; name: string; models: { id: string; name: string; efforts: { id: string; name: string }[]; defaultEffort?: string }[] }
export type Frame =
  | { type: 'snapshot'; cursor: number; records: unknown[] }
  | { type: 'event'; seq: number; eventType: string; data: unknown }
  | { type: 'assistant-stream'; frame: unknown }

interface Controller {
  list(r: unknown, s: AbortSignal): Promise<{ items?: Json[] }>
  create(r: unknown): Promise<{ sessionId?: unknown }>
  prompt(r: unknown, s: AbortSignal): Promise<unknown>
  cancel(r: unknown): unknown
  follow(r: unknown, s: AbortSignal): AsyncIterable<Json>
  modelCatalog(): Promise<unknown>
  projections?(r: unknown, s: AbortSignal): Promise<unknown>
}
interface AgentLike { model: { select(s: ModelChoice): void } }

export function projectSession(row: unknown): SessionRow | undefined {
  const item = rec(row)
  if (item['origin'] === 'subagent') return undefined
  const sessionId = str(item['sessionId'])
  if (sessionId === undefined) return undefined
  const title = str(rec(rec(item['projections'])['values'])['title'])
  const cwd = str(item['cwd'])
  return { sessionId, ...(title === undefined ? {} : { title }), ...(cwd === undefined ? {} : { cwd }), updatedAt: typeof item['updatedAt'] === 'number' ? item['updatedAt'] : 0, running: item['running'] === true, blank: item['blank'] === true }
}

export function readGroups(catalog: unknown): ModelGroup[] {
  const groups = rec(catalog)['groups']
  if (!Array.isArray(groups)) return []
  return groups.flatMap((g): ModelGroup[] => {
    const group = rec(g)
    const provider = str(group['id'])
    if (provider === undefined || !Array.isArray(group['models'])) return []
    const models = (group['models'] as unknown[]).flatMap((m) => {
      const model = rec(m)
      const id = str(model['id'])
      if (id === undefined) return []
      const reasoning = rec(model['reasoning'])
      const efforts = Array.isArray(reasoning['efforts']) ? (reasoning['efforts'] as unknown[]).flatMap((e) => { const x = rec(e); const eid = str(x['id']); return eid === undefined ? [] : [{ id: eid, name: str(x['name']) ?? eid }] }) : []
      const defaultEffort = str(reasoning['defaultEffort'])
      return [{ id, name: str(model['name']) ?? id, efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }]
    })
    return models.length === 0 ? [] : [{ provider, name: str(group['name']) ?? provider, models }]
  })
}

export function readCurrent(projections: unknown): ModelChoice | undefined {
  const next = rec(rec(rec(rec(projections)['values'])['modelSelection'])['next'])
  const provider = str(next['provider']); const model = str(next['model'])
  if (provider === undefined || model === undefined) return undefined
  const effort = str(next['reasoningEffort'])
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

export class Harness {
  constructor(private readonly ctx: Context, private readonly config: () => Config) {}

  private get controller(): Controller {
    const c = this.ctx.get('sessionController' as never) as Controller | undefined
    if (c === undefined) throw new Error('the session controller is not available yet')
    return c
  }

  describe(): Json {
    return { sessionController: this.ctx.get('sessionController' as never) !== undefined }
  }

  workspaces(): WorkspaceRow[] {
    const registry = this.ctx.get('workspaceRegistry' as never) as { list(): unknown[] } | undefined
    return (registry?.list() ?? []).flatMap((w) => {
      const x = rec(w); const id = str(x['workspaceId']) ?? str(x['id'])
      return id === undefined ? [] : [{ workspaceId: id, title: str(x['title']) ?? id, path: str(x['path']) ?? '' }]
    })
  }

  /** The workspace new HUD chats join: configured id/path, else the first registered, else the profile default. */
  async hudWorkspace(): Promise<WorkspaceRow | undefined> {
    const wanted = this.config().workspace
    const list = this.workspaces()
    const match = wanted === '' ? undefined : list.find((w) => w.workspaceId === wanted || w.path === wanted)
    if (match !== undefined) return match
    if (list[0] !== undefined) return list[0]
    const controller = this.ctx.get('workspaceController' as never) as { initializeDefault(s: AbortSignal): Promise<{ workspace?: unknown } | undefined> } | undefined
    const created = await controller?.initializeDefault(new AbortController().signal)
    const x = rec(created?.workspace); const id = str(x['id']) ?? str(x['workspaceId'])
    return id === undefined ? undefined : { workspaceId: id, title: str(x['title']) ?? id, path: str(x['path']) ?? '' }
  }

  async sessions(): Promise<SessionRow[]> {
    const value = await this.controller.list({}, new AbortController().signal)
    return (value.items ?? []).flatMap((row) => projectSession(row) ?? [])
  }

  async createSession(workspaceId?: string): Promise<{ sessionId: string; model?: ModelChoice }> {
    const workspace = workspaceId !== undefined && workspaceId !== '' ? workspaceId : (await this.hudWorkspace())?.workspaceId
    if (workspace === undefined) throw new Error('no workspace is available: create one in the web UI first')
    const created = await this.controller.create({ workspaceId: workspace })
    const sessionId = str(created.sessionId)
    if (sessionId === undefined) throw new Error('session creation returned no id')
    const model = await this.applyDefaultModel(sessionId)
    return { sessionId, ...(model === undefined ? {} : { model }) }
  }

  /** Put the configured HUD model on a fresh session (per session; the global default stays untouched). */
  private async applyDefaultModel(sessionId: string): Promise<ModelChoice | undefined> {
    const { model, provider, effort } = this.config()
    if (model === '') return undefined
    const groups = readGroups(await this.controller.modelCatalog().catch(() => undefined))
    const group = groups.find((g) => (provider === '' || g.provider === provider) && g.models.some((m) => m.id === model))
    if (group === undefined) return undefined
    const entry = group.models.find((m) => m.id === model)
    const reasoningEffort = entry?.efforts.some((e) => e.id === effort) === true ? effort : entry?.defaultEffort
    const choice: ModelChoice = { provider: group.provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    this.selectModel(sessionId, choice)
    return choice
  }

  selectModel(sessionId: string, choice: ModelChoice): void {
    const agents = this.ctx.get('agents' as never) as { get(id: string): AgentLike | undefined } | undefined
    const agent = agents?.get(sessionId)
    if (agent === undefined) throw new Error('this session is not loaded; send a message first, then change its model')
    agent.model.select(choice)
  }

  async options(sessionId?: string): Promise<{ groups: ModelGroup[]; current?: ModelChoice }> {
    const groups = readGroups(await this.controller.modelCatalog().catch(() => undefined))
    let current: ModelChoice | undefined
    if (sessionId !== undefined && this.controller.projections !== undefined) {
      current = readCurrent(await this.controller.projections({ sessionId }, new AbortController().signal).catch(() => undefined))
    }
    return { groups, ...(current === undefined ? {} : { current }) }
  }

  async prompt(sessionId: string, requestId: string, text: string): Promise<void> {
    await this.controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
  }

  cancel(sessionId: string): void { void this.controller.cancel({ sessionId }) }

  follow(sessionId: string, onFrame: (f: Frame) => void, onError: (e: unknown) => void): () => void {
    const abort = new AbortController()
    const iterator = this.controller.follow({ address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 120, turnWindow: { minMessages: 30, minTurns: 2 } }, abort.signal)
    void (async () => {
      try {
        for await (const frame of iterator) {
          if (abort.signal.aborted) break
          const type = frame['type']
          if (type === 'snapshot') onFrame({ type, cursor: typeof frame['cursor'] === 'number' ? frame['cursor'] : -1, records: Array.isArray(frame['records']) ? frame['records'] : [] })
          else if (type === 'event') {
            const e = rec(frame['event'])
            onFrame({ type, seq: typeof e['seq'] === 'number' ? e['seq'] : -1, eventType: str(e['type']) ?? 'unknown', data: e['data'] ?? null })
          } else if (type === 'assistant-stream') onFrame({ type, frame: frame['frame'] ?? null })
        }
      } catch (error) { if (!abort.signal.aborted) onError(error) }
    })()
    return () => { abort.abort(new Error('dsh-hud: follow closed')) }
  }

  /**
   * The plain advertised web URL (HUD-1): never the tokenised login URL. The browser the user opens already holds
   * the auth cookie; a process that merely reaches this socket must not be able to mint a signed-in client.
   * The session is selected by the plugin's client half through the URL fragment.
   */
  webUrl(sessionId?: string): string | undefined {
    const app = this.ctx.get('webApp' as never) as { getAdvertisedUrl(): string } | undefined
    if (app === undefined) return undefined
    const url = stripCredentials(app.getAdvertisedUrl())
    return sessionId === undefined ? url : `${url}#dsh-hud-session=${encodeURIComponent(sessionId)}`
  }

  /** Permission mode of a live session, or undefined when the session is not loaded. */
  modeOf(sessionId: string): string | undefined {
    const sessions = this.ctx.get('sessions' as never) as { get(id: string): unknown } | undefined
    const policy = this.ctx.get('sandboxPolicy' as never) as { resolve(r: { session: unknown }): { mode?: string } } | undefined
    const session = sessions?.get(sessionId)
    if (session === undefined || policy === undefined) return undefined
    return policy.resolve({ session }).mode
  }

  /** Mode a brand-new session starts in (the deployment default). */
  defaultMode(): string | undefined {
    const policy = this.ctx.get('sandboxPolicy' as never) as { resolve(r?: unknown): { mode?: string } } | undefined
    return policy?.resolve().mode
  }

  /**
   * Trust boundary (HUD-1): the socket is reachable by any same-uid process, including ones a sandboxed agent
   * started, so the HUD may not drive a session that runs without a sandbox unless the operator opted in.
   * Fails closed: a session that is not loaded has an unknown mode and is refused too.
   */
  assertMayDrive(sessionId: string): void {
    if (this.config().allowDangerousSessions) return
    const mode = this.modeOf(sessionId)
    if (mode === undefined) throw new GuardError(`session ${sessionId} is not loaded, so its permission mode is unknown. Open it in the web UI first, or set allowDangerousSessions in the dsh-hud config.`)
    if (mode === 'danger-full-access') throw new GuardError(`session ${sessionId} runs in danger-full-access mode; the HUD may only drive read-only or workspace-write sessions (set allowDangerousSessions in the dsh-hud config to override).`)
  }

  assertMayCreate(): void {
    if (this.config().allowDangerousSessions) return
    const mode = this.defaultMode()
    if (mode === undefined || mode === 'danger-full-access') throw new GuardError('new sessions would start in danger-full-access mode (or the mode is unknown); the HUD will not create them. Set allowDangerousSessions in the dsh-hud config to override.')
  }
}

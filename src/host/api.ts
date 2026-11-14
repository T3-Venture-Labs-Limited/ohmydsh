/** Thin REST client for the consumer project (`/api/v3.1`), authenticated with the CLI's user key. */
import { redact, readCreds, type Creds } from './creds.ts'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export interface AccountRow {
  id: string; wordId: string; alias: string | null; status: string; statusReason: string | null; disabled: boolean
  toolkit: string; toolkitName: string; authScheme: string | null; composioManaged: boolean; createdAt: string | null
}
export interface TriggerType { slug: string; name: string; description: string; type: string; instructions: string; config: unknown }
export interface TriggerInstance { id: string; slug: string; connectedAccountId: string | null; disabled: boolean }

type Fetch = typeof fetch
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {})

export class ComposioApi {
  constructor(private readonly creds: () => Creds = readCreds, private readonly fetchImpl: Fetch = fetch) {}

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const c = this.creds()
    let response: Response
    try {
      response = await this.fetchImpl(c.baseUrl + path, {
        method,
        headers: { 'x-user-api-key': c.apiKey, 'x-org-id': c.orgId, 'x-project-id': c.projectId, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) { throw new ApiError(0, redact(error instanceof Error ? error.message : String(error), c)) }
    const text = await response.text()
    let json: unknown = text
    try { json = text === '' ? null : JSON.parse(text) } catch { /* keep text */ }
    if (!response.ok) {
      const message = str(rec(rec(json)['error'])['message']) ?? str(rec(json)['message']) ?? `HTTP ${String(response.status)}`
      throw new ApiError(response.status, redact(message, c))
    }
    return json
  }

  async connectedAccounts(): Promise<AccountRow[]> {
    const out: AccountRow[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const json = rec(await this.request('GET', `/api/v3.1/connected_accounts?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`))
      for (const raw of Array.isArray(json['items']) ? json['items'] : []) {
        const i = rec(raw); const toolkit = rec(i['toolkit']); const auth = rec(i['auth_config'])
        // `data` (tokens) is deliberately never copied.
        out.push({
          id: str(i['id']) ?? '', wordId: str(i['word_id']) ?? '', alias: str(i['alias']), status: str(i['status']) ?? 'UNKNOWN', statusReason: str(i['status_reason']),
          disabled: i['is_disabled'] === true, toolkit: str(toolkit['slug']) ?? '', toolkitName: str(toolkit['name']) ?? str(toolkit['slug']) ?? '',
          authScheme: str(auth['auth_scheme']), composioManaged: auth['is_composio_managed'] === true, createdAt: str(i['created_at']),
        })
      }
      cursor = str(json['next_cursor'])
      if (cursor === null) break
    }
    return out
  }

  async triggerTypes(toolkit: string): Promise<TriggerType[]> {
    const json = rec(await this.request('GET', `/api/v3.1/triggers_types?toolkit_slugs=${encodeURIComponent(toolkit)}&limit=100`))
    return (Array.isArray(json['items']) ? json['items'] : []).map((raw) => {
      const i = rec(raw)
      return { slug: str(i['slug']) ?? '', name: str(i['name']) ?? '', description: str(i['description']) ?? '', type: str(i['type']) ?? 'webhook', instructions: str(i['instructions']) ?? '', config: i['config'] ?? {} }
    })
  }

  async activeTriggers(): Promise<TriggerInstance[]> {
    const json = rec(await this.request('GET', '/api/v3.1/trigger_instances/active?limit=100'))
    return (Array.isArray(json['items']) ? json['items'] : []).map((raw) => {
      const i = rec(raw)
      return { id: str(i['id']) ?? str(i['trigger_id']) ?? '', slug: str(i['trigger_name']) ?? str(i['slug']) ?? '', connectedAccountId: str(i['connected_account_id']), disabled: i['disabled_at'] != null }
    })
  }

  /** Create (upsert) a trigger instance for one connected account. Returns the `ti_*` id. */
  async createTrigger(slug: string, connectedAccountId: string, triggerConfig: Record<string, unknown>): Promise<string> {
    const c = this.creds()
    const json = rec(await this.request('POST', `/api/v3.1/trigger_instances/${encodeURIComponent(slug)}/upsert`, { user_id: c.consumerUserId, connected_account_id: connectedAccountId, trigger_config: triggerConfig }))
    const id = str(json['trigger_id']) ?? str(json['id'])
    if (id === null) throw new ApiError(502, 'Composio did not return a trigger id')
    return id
  }
  async deleteTrigger(id: string): Promise<void> { await this.request('DELETE', `/api/v3.1/trigger_instances/manage/${encodeURIComponent(id)}`) }
  async setTriggerStatus(id: string, status: 'enable' | 'disable'): Promise<void> { await this.request('PATCH', `/api/v3.1/trigger_instances/manage/${encodeURIComponent(id)}`, { status }) }
  async realtimeCredentials(): Promise<{ pusherKey: string; projectId: string; cluster: string }> {
    const j = rec(await this.request('GET', '/api/v3.1/cli/realtime/credentials'))
    return { pusherKey: str(j['pusher_key']) ?? '', projectId: str(j['project_id']) ?? '', cluster: str(j['pusher_cluster']) ?? '' }
  }
  async realtimeAuth(socketId: string, channelName: string): Promise<unknown> {
    return this.request('POST', '/api/v3.1/cli/realtime/auth', { socket_id: socketId, channel_name: channelName })
  }
}

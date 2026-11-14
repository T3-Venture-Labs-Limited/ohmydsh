/**
 * ComposioService: the operations both the UI routes and the agent tools call (one implementation, per the
 * "user actions" guidance). Everything returns compact, capped data.
 */
import { ComposioApi, type AccountRow } from './api.ts'
import { ComposioCli, CliError } from './cli.ts'
import { riskOf, type Risk } from './risk.ts'

export const MAX_TEXT = 12_000
const clip = (text: string, n = MAX_TEXT): string => (text.length <= n ? text : `${text.slice(0, n)}\n…[truncated ${String(text.length - n)} chars]`)

export interface ToolSummary { slug: string; name: string; description: string; toolkit: string; risk: Risk }
export interface ToolkitRow { slug: string; name: string; accounts: { id?: string; wordId: string; alias: string | null; status: string }[]; hasExpired: boolean }

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {})

export class ComposioService {
  private tagCache = new Map<string, { at: number; tags: Map<string, string[]> }>()
  constructor(readonly cli: ComposioCli, readonly api: ComposioApi) {}

  /** whoami + login health. Never throws. */
  async health(): Promise<{ ok: boolean; email?: string; org?: string; error?: string }> {
    try {
      const w = rec(await this.cli.json(['whoami'], { timeoutMs: 20_000 }))
      return { ok: true, ...(typeof w['email'] === 'string' ? { email: w['email'] } : {}), ...(typeof w['current_org_name'] === 'string' ? { org: w['current_org_name'] } : {}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  /** Accounts grouped by toolkit (REST for ids + auth info; `data` is never copied). */
  async connections(): Promise<ToolkitRow[]> {
    const rows = await this.api.connectedAccounts()
    const by = new Map<string, ToolkitRow & { _name: string }>()
    for (const a of rows) {
      const t = by.get(a.toolkit) ?? { slug: a.toolkit, name: a.toolkitName || a.toolkit, _name: a.toolkitName, accounts: [], hasExpired: false }
      t.accounts.push({ id: a.id, wordId: a.wordId, alias: a.alias, status: a.status })
      if (a.status !== 'ACTIVE' && a.status !== 'INITIALIZING') t.hasExpired = true
      by.set(a.toolkit, t)
    }
    return [...by.values()].map(({ _name, ...t }) => t).sort((a, b) => a.slug.localeCompare(b.slug))
  }
  accountsRaw(): Promise<AccountRow[]> { return this.api.connectedAccounts() }

  /** Start a Connect Link. Returns the URL for the USER to open; completing OAuth is user-only. */
  async link(toolkit: string, alias?: string): Promise<{ status: string; accountId: string; url: string }> {
    if (!/^[a-z0-9_-]{1,64}$/i.test(toolkit)) throw new Error('Invalid toolkit slug')
    if (alias !== undefined && !/^[\w@.\- ]{1,64}$/.test(alias)) throw new Error('Invalid alias')
    const out = rec(await this.cli.json(['link', toolkit, '--no-browser', '--no-wait', ...(alias === undefined ? [] : ['--alias', alias])], { timeoutMs: 45_000 }))
    const url = typeof out['redirect_url'] === 'string' ? out['redirect_url'] : ''
    if (url === '') throw new CliError('failed', typeof out['message'] === 'string' ? out['message'] : 'Composio did not return a connect link')
    return { status: String(out['status'] ?? 'pending'), accountId: String(out['connected_account_id'] ?? ''), url }
  }

  async tools(toolkit: string, query?: string, limit = 40): Promise<ToolSummary[]> {
    if (!/^[a-z0-9_-]{1,64}$/i.test(toolkit)) throw new Error('Invalid toolkit slug')
    const raw = await this.cli.json(['tools', 'list', toolkit, ...(query === undefined || query === '' ? [] : ['--query', query]), '--limit', String(Math.min(Math.max(limit, 1), 500))], { timeoutMs: 40_000 })
    const items = Array.isArray(raw) ? raw : []
    return items.map((i) => {
      const r = rec(i); const tags = Array.isArray(r['tags']) ? r['tags'].filter((t): t is string => typeof t === 'string') : []
      return { slug: String(r['slug'] ?? ''), name: String(r['name'] ?? ''), description: String(r['description'] ?? '').slice(0, 220), toolkit, risk: riskOf(tags) }
    })
  }

  /** Risk of one slug: tags come from `tools list <toolkit>`; cached per toolkit for 10 minutes. */
  async riskOfSlug(slug: string): Promise<Risk> {
    const toolkit = slug.split('_')[0]?.toLowerCase() ?? ''
    const hit = this.tagCache.get(toolkit)
    if (hit !== undefined && Date.now() - hit.at < 600_000) return riskOf(hit.tags.get(slug) ?? [])
    try {
      const raw = await this.cli.json(['tools', 'list', toolkit, '--limit', '2000'], { timeoutMs: 40_000 })
      const tags = new Map<string, string[]>()
      for (const i of Array.isArray(raw) ? raw : []) { const r = rec(i); if (typeof r['slug'] === 'string') tags.set(r['slug'], Array.isArray(r['tags']) ? r['tags'].filter((t): t is string => typeof t === 'string') : []) }
      this.tagCache.set(toolkit, { at: Date.now(), tags })
      return riskOf(tags.get(slug) ?? [])
    } catch { return 'unknown' }
  }

  async search(queries: string[], toolkits?: string[], limit = 5): Promise<{ results: { useCase: string; primary: string[]; related: string[] }[]; connected: string[] }> {
    const out = rec(await this.cli.json(['search', ...queries.slice(0, 4), ...(toolkits === undefined || toolkits.length === 0 ? [] : ['--toolkits', toolkits.join(',')]), '--limit', String(Math.min(Math.max(limit, 1), 10))], { timeoutMs: 60_000 }))
    const results = (Array.isArray(out['results']) ? out['results'] : []).map((r) => {
      const o = rec(r)
      const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      return { useCase: String(o['use_case'] ?? ''), primary: arr(o['primary_tool_slugs']), related: arr(o['related_tool_slugs']).slice(0, 8) }
    })
    return { results, connected: (Array.isArray(out['connected_toolkits']) ? out['connected_toolkits'] : []).filter((x): x is string => typeof x === 'string') }
  }

  /** Input schema of one tool (CLI-facing JSON schema). */
  async schema(slug: string): Promise<unknown> {
    if (!/^[A-Z0-9_]{2,120}$/.test(slug)) throw new Error('Invalid tool slug')
    const info = rec(await this.cli.json(['tools', 'info', slug], { timeoutMs: 30_000 }))
    return { slug: info['slug'], name: info['name'], description: info['description'], inputSchema: info['inputSchema'] }
  }

  /** Execute one tool. Arguments go through stdin (`-d -`), never the command line. */
  async execute(slug: string, args: unknown, opts: { account?: string | undefined; dryRun?: boolean | undefined; signal?: AbortSignal | undefined } = {}): Promise<{ text: string; ok: boolean; stored?: string }> {
    if (!/^[A-Z0-9_]{2,120}$/.test(slug)) throw new Error('Invalid tool slug')
    const argv = ['execute', slug, '-d', '-', ...(opts.account === undefined ? [] : ['--account', opts.account]), ...(opts.dryRun === true ? ['--dry-run'] : [])]
    const r = await this.cli.run(argv, { stdin: JSON.stringify(args ?? {}), timeoutMs: 120_000, ...(opts.signal === undefined ? {} : { signal: opts.signal }) })
    const body = (r.stdout.trim() || r.stderr.trim()).slice(0, 2_000_000)
    let stored: string | undefined
    try { const j = rec(JSON.parse(body)); if (typeof j['outputFilePath'] === 'string') stored = j['outputFilePath'] } catch { /* plain text */ }
    return { text: clip(body), ok: r.code === 0, ...(stored === undefined ? {} : { stored }) }
  }
}

/** The four agent tools. Compact schemas, capped output, risk tags; each is a thin call into ComposioService. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ComposioService } from './service.ts'

const text = (value: string): { type: 'text'; text: string }[] => [{ type: 'text', text: value }]
const STR = { type: 'string' } as const

export function composioTools(service: ComposioService) {
  const search = defineTool({
    name: 'composio_search',
    description: 'Find Composio tools by use case (e.g. "create a github issue"). Returns tool slugs per use case and the connected toolkits. Then call composio_execute with get_schema:true to see arguments.',
    parameters: {
      queries: { type: 'array', items: { type: 'string' }, required: true, description: 'One to four short use-case phrases.' },
      toolkits: { type: 'array', items: { type: 'string' }, description: 'Optional toolkit slugs to restrict to, e.g. ["github"].' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { results: { type: 'json', required: true }, connected: { type: 'json', required: true } } },
      render: (_a: unknown, v: { results: unknown; connected: unknown }) => text(JSON.stringify(v)),
    },
    async execute(args: { queries: string[]; toolkits?: string[] }) {
      const out = await service.search(args.queries, args.toolkits, 5)
      return { results: out.results as unknown as never, connected: out.connected as unknown as never }
    },
  })
  const execute = defineTool({
    name: 'composio_execute',
    description: 'Run a Composio tool by slug with JSON arguments, or fetch its argument schema (get_schema:true). Read-only tools run directly; actions that write or delete ask for approval. Large results are stored in a file (path returned).',
    parameters: {
      slug: { ...STR, required: true, description: 'Tool slug, e.g. GITHUB_CREATE_AN_ISSUE.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Tool arguments as an object.' },
      account: { ...STR, description: 'Connected account alias or word_id when the toolkit has several.' },
      get_schema: { type: 'boolean', description: 'Return the input schema instead of running.' },
      dry_run: { type: 'boolean', description: 'Validate and preview without running.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, result: STR, stored_in: STR } },
      render: (_a: unknown, v: { ok: boolean; result?: string; stored_in?: string }) => text(`${v.ok ? '' : 'FAILED: '}${v.result ?? ''}${v.stored_in === undefined ? '' : `\n[full output stored in ${v.stored_in}]`}`),
    },
    timeoutMs: 150_000,
    async execute(args: { slug: string; arguments?: Record<string, unknown>; account?: string; get_schema?: boolean; dry_run?: boolean }, exec) {
      if (args.get_schema === true) return { ok: true, result: JSON.stringify(await service.schema(args.slug)).slice(0, 12_000) }
      const r = await service.execute(args.slug, args.arguments ?? {}, { account: args.account, dryRun: args.dry_run, signal: exec.signal })
      return { ok: r.ok, result: r.text, ...(r.stored === undefined ? {} : { stored_in: r.stored }) }
    },
  })
  const link = defineTool({
    name: 'composio_link',
    description: 'Start connecting (or re-authorising) an account for a toolkit. Returns a Connect URL for the USER to open; never opens it and cannot finish OAuth itself. Use an alias for a second account of the same toolkit.',
    parameters: {
      toolkit: { ...STR, required: true, description: 'Toolkit slug, e.g. github, gmail.' },
      alias: { ...STR, description: 'Alias for an additional account.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', required: true }, status: { type: 'string', required: true } } },
      render: (_a: unknown, v: { url: string }) => text(`Ask the user to open this link and approve access, then call composio_status:\n${v.url}`),
    },
    async execute(args: { toolkit: string; alias?: string }) {
      const r = await service.link(args.toolkit, args.alias)
      return { url: r.url, status: r.status }
    },
  })
  const status = defineTool({
    name: 'composio_status',
    description: 'List connected Composio toolkits and their accounts (ACTIVE / EXPIRED). Use before composio_execute when a call fails with a connection error.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { toolkits: { type: 'json', required: true } } },
      render: (_a: unknown, v: { toolkits: unknown }) => text(JSON.stringify(v.toolkits)),
    },
    async execute() {
      const rows = await service.connections()
      return { toolkits: rows.map((t) => ({ toolkit: t.slug, accounts: t.accounts.map((a) => `${a.alias ?? a.wordId}:${a.status}`) })) as unknown as never }
    },
  })
  return [search, execute, link, status]
}

/** Agent tools: triggers_list, triggers_save, triggers_test. They never return a webhook secret. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AutomationView, RunRow } from '../shared/types.ts'
import type { TriggersEngine } from './engine.ts'

const text = (value: string): { type: 'text'; text: string }[] => [{ type: 'text', text: value }]

/**
 * Tool outputs must be lossless JSON: DSH rejects `undefined` anywhere in the value ("value is not lossless JSON").
 * Round-trip through JSON to drop undefined fields (and anything else JSON cannot hold).
 */
export const lossless = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const summary = (a: AutomationView): Record<string, unknown> => lossless({
  id: a.id, name: a.name, enabled: a.enabled, description: a.description || undefined,
  createdAt: new Date(a.createdAt).toISOString(), updatedAt: new Date(a.updatedAt).toISOString(),
  prompt: a.prompt, maxEventChars: a.maxEventChars,
  source: a.source, webhookUrl: a.webhookUrl, hasSecret: a.secretHint !== null,
  target: { mode: a.target.mode, cwd: a.target.cwd, model: a.target.model, sandbox: a.target.sandbox, tools: a.target.tools, title: a.target.title, sessionId: a.target.sessionId },
  limits: a.limits, consecutiveFailures: a.consecutiveFailures,
  lastRun: a.lastRun === null ? null : runSummary(a.lastRun),
})
const runSummary = (r: RunRow): Record<string, unknown> => lossless({ runId: r.runId, at: new Date(r.at).toISOString(), status: r.status, reason: r.reason, summary: r.summary, sessionId: r.sessionId, error: r.error, test: r.test })

const SOURCE_DOC = 'Source object. webhook: {kind:"webhook", auth:"token"|"hmac-sha256"|"standard-webhooks"|"none", events:[]}; '
  + 'file: {kind:"file", path:"/abs/dir or ~/dir", pattern:"transcript.md" (glob on the file name), settleMs:8000, requireSibling?:{file,field,equals}}; '
  + 'composio: {kind:"composio", triggerSlug:"GMAIL_NEW_GMAIL_MESSAGE", triggerInstanceId?}.'
const TARGET_DOC = 'Target object: {mode:"new"|"reuse", cwd:"/abs/workspace", model:null|{provider,model,reasoningEffort?}, sandbox:"read-only"|"workspace-write", tools:"read"|"standard", title:"Meeting: {{file.dirname}}"}.'

export function triggerTools(engine: TriggersEngine) {
  const list = defineTool({
    name: 'triggers_list',
    description: 'List the Triggers automations (event → chat): source, target, enabled, last run, webhook URL. Secrets are never shown.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { paused: { type: 'boolean', required: true }, automations: { type: 'json', required: true } } },
      render: (_a: unknown, v: { paused: boolean; automations: unknown }) => text(JSON.stringify(v)),
    },
    async execute() {
      const state = engine.state()
      return { paused: state.paused, automations: state.automations.map(summary) as unknown as never }
    },
  })
  const save = defineTool({
    name: 'triggers_save',
    description: 'Create or update a Triggers automation: when the source fires (webhook POST, new file, Composio event), a chat runs the prompt with the event fenced as untrusted data. '
      + 'To create: pass name, source, target and prompt. To update: pass id plus ONLY the fields to change (others keep their saved values; source/target/limits are merged one level deep). '
      + 'The prompt should contain {{event_fenced}}; variables: {{event.<path>}}, {{file.path}}, {{file.name}}, {{file.dirname}} (folder name), {{file.dir}} (folder path), {{received_at}}, {{automation}}. '
      + 'The webhook secret is never returned here: tell the user to copy it from the Triggers page (it is shown once there, or use Rotate).',
    parameters: {
      id: { type: 'string', description: 'Existing automation id to update. Omit to create.' },
      name: { type: 'string', description: 'Required when creating.' },
      description: { type: 'string' },
      enabled: { type: 'boolean' },
      source: { type: 'object', additionalProperties: true, description: SOURCE_DOC + ' Required when creating.' },
      target: { type: 'object', additionalProperties: true, description: TARGET_DOC + ' Required when creating.' },
      prompt: { type: 'string', description: 'Trusted instructions for the run. Required when creating.' },
      limits: { type: 'object', additionalProperties: true, description: '{maxPerHour (default 12), minIntervalSec (default 10)}' },
      maxEventChars: { type: 'integer', description: 'Event JSON passed to the model is truncated to this many characters (default 12000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { automation: { type: 'json', required: true }, warnings: { type: 'json', required: true }, note: { type: 'string' } } },
      render: (_a: unknown, v: { automation: unknown; warnings: unknown; note?: string }) => text(JSON.stringify(v)),
    },
    async execute(args: Record<string, unknown>) {
      const r = await engine.save(mergeUpdate(engine, args))
      const note = r.secret === undefined ? undefined : 'A webhook secret was generated. It is not shown to you: ask the user to open the Triggers page and copy it (or use Rotate secret).'
      return { automation: summary(r.automation) as never, warnings: lossless(r.warnings) as never, ...(note === undefined ? {} : { note }) }
    },
  })
  const test = defineTool({
    name: 'triggers_test',
    description: 'Fire an automation once with a sample event (bypasses limits, enabled and paused). Returns the run row; the run opens/wakes a chat like a real event.',
    parameters: {
      id: { type: 'string', required: true },
      payload: { type: 'json', description: 'Sample event data (webhook/composio). For file automations: {path:"/abs/file"} to use a specific file; default = the newest matching file.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { run: { type: 'json', required: true } } },
      render: (_a: unknown, v: { run: unknown }) => text(JSON.stringify(v.run)),
    },
    timeoutMs: 60_000,
    async execute(args: { id: string; payload?: unknown }) {
      const row = await engine.test(args.id, args.payload)
      return { run: runSummary(row) as never }
    },
  })
  const setEnabled = defineTool({
    name: 'triggers_set_enabled',
    description: 'Enable or disable a Triggers automation without changing anything else.',
    parameters: { id: { type: 'string', required: true }, enabled: { type: 'boolean', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, enabled: { type: 'boolean', required: true } } },
      render: (_a: unknown, v: { id: string; enabled: boolean }) => text(`${v.id} is now ${v.enabled ? 'enabled' : 'disabled'}.`),
    },
    async execute(args: { id: string; enabled: boolean }) {
      await engine.setEnabled(args.id, args.enabled)
      return { id: args.id, enabled: args.enabled }
    },
  })
  const remove = defineTool({
    name: 'triggers_delete',
    description: 'Delete a Triggers automation (its run history stays; chats it created are kept). Ask the user before deleting.',
    parameters: { id: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'string', required: true } } },
      render: (_a: unknown, v: { deleted: string }) => text(`Deleted ${v.deleted}.`),
    },
    async execute(args: { id: string }) {
      await engine.remove(args.id)
      return { deleted: args.id }
    },
  })
  return [list, save, test, setEnabled, remove]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Partial update for the agent: start from the saved automation and overlay only the fields passed.
 * `source`, `target` and `limits` merge one level deep; changing `source.kind` replaces the source.
 */
export function mergeUpdate(engine: Pick<TriggersEngine, 'get'>, args: Record<string, unknown>): Record<string, unknown> {
  const id = args['id']
  if (typeof id !== 'string' || id === '') return args
  const prior = engine.get(id)
  if (prior === undefined) return args
  const base: Record<string, unknown> = {
    id, name: prior.name, description: prior.description, enabled: prior.enabled,
    source: prior.source, target: { ...prior.target }, prompt: prior.prompt, limits: prior.limits, maxEventChars: prior.maxEventChars,
  }
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    if ((key === 'source' || key === 'target' || key === 'limits') && isRecord(value) && isRecord(base[key])) {
      const prev = base[key] as Record<string, unknown>
      out[key] = key === 'source' && value['kind'] !== undefined && value['kind'] !== prev['kind'] ? value : { ...prev, ...value }
    } else out[key] = value
  }
  // sessionId is host-managed: never part of a save request.
  if (isRecord(out['target'])) { const { sessionId: _s, ...rest } = out['target']; void _s; out['target'] = rest }
  return out
}

/**
 * Shared data model for dsh-triggers (host + browser). Plain data only: no imports from either side.
 *
 * Vocabulary
 *  - Automation: one user-defined rule = a Source (what fires it) + a Target (where the run goes) + a prompt template.
 *  - Source: webhook | file | composio.
 *  - Event: one occurrence a source produced (one webhook POST, one settled file, one Composio trigger message).
 *  - Run: the log row for one event (accepted/skipped/delivered/failed, linked session).
 */

export type SourceKind = 'webhook' | 'file' | 'composio'

/** How a webhook request proves it is genuine. */
export type WebhookAuth =
  /** `Authorization: Bearer <secret>` or `X-Trigger-Token: <secret>`. Good for scripts, CI, curl. */
  | 'token'
  /** `X-Hub-Signature-256: sha256=<hex hmac of raw body>` (GitHub style). */
  | 'hmac-sha256'
  /** Standard Webhooks / Svix: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>` over `id.timestamp.body`, secret `whsec_<base64>`. */
  | 'standard-webhooks'
  /** No secret. Accepted ONLY from loopback (127.0.0.1 / ::1). */
  | 'none'

export interface WebhookSource {
  kind: 'webhook'
  auth: WebhookAuth
  /** Optional filter: only fire when the event-type header (X-GitHub-Event / X-Event-Type / body.type) is in this list. Empty = all. */
  events: string[]
}

export interface FileSource {
  kind: 'file'
  /** Absolute directory to watch (recursively). `~` is expanded on save. */
  path: string
  /** Glob on the file NAME (not path), e.g. `transcript.md`, `*.pdf`. */
  pattern: string
  /** Fire this many ms after the last write to the matched file (debounce / "file finished"). */
  settleMs: number
  /** Ignore matched files whose parent directory is older than this when the automation is created (no back catalogue). Always true for now. */
  ignoreExisting: boolean
  /** Optional: only fire when a JSON file next to the match satisfies a condition, e.g. metadata.json `status == completed`. */
  requireSibling?: { file: string; field: string; equals: string } | undefined
}

export interface ComposioSource {
  kind: 'composio'
  /** Composio trigger slug, e.g. GMAIL_NEW_GMAIL_MESSAGE. Routing from Composio events is done by dsh-composio. */
  triggerSlug: string
  /** Composio trigger instance id (set when the trigger is created in Composio). */
  triggerInstanceId?: string | undefined
  connectedAccountId?: string | undefined
}

export type Source = WebhookSource | FileSource | ComposioSource

export interface ModelRoute { provider: string; model: string; reasoningEffort?: string }

export type SandboxMode = 'read-only' | 'workspace-write'

export interface Target {
  /** `new` = a new chat per event; `reuse` = one chat for this automation, created on first event and woken afterwards. */
  mode: 'new' | 'reuse'
  /** Workspace directory the chat runs in (absolute). */
  cwd: string
  /** null = the profile default model. */
  model: ModelRoute | null
  /** File sandbox for the run. Never looser than the profile default. */
  sandbox: SandboxMode
  /**
   * Tools the run may use. 'read' = read-only tools only (read/glob/grep/skill/read_image/web_search/web_fetch);
   * 'standard' = the session's normal tool set under the sandbox above (approvals still apply).
   */
  tools: 'read' | 'standard'
  /** Session title template, e.g. `Meeting: {{file.dirname}}`. */
  title: string
  /** Set by the host for mode=reuse after the first run. */
  sessionId?: string | undefined
}

export interface Limits {
  /** Max delivered runs per rolling hour for this automation. */
  maxPerHour: number
  /** Minimum seconds between two delivered runs. */
  minIntervalSec: number
}

export interface Automation {
  id: string
  name: string
  description: string
  enabled: boolean
  source: Source
  target: Target
  /**
   * Trusted instructions. Variables: {{event_fenced}} (the event as fenced, escaped JSON — always add this or it is appended),
   * {{event.<path>}} (one field, JSON-escaped), {{file.path}}, {{file.dirname}}, {{file.name}}, {{received_at}}, {{automation}}.
   */
  prompt: string
  limits: Limits
  /** Payload passed to the model is truncated to this many characters. */
  maxEventChars: number
  createdAt: number
  updatedAt: number
  /** Consecutive delivery failures; the automation auto-disables at 3. */
  consecutiveFailures: number
}

/** What the browser sees: the secret never leaves the host after creation; only whether one exists + a short hint. */
export interface AutomationView extends Automation {
  /** Absolute webhook URL (loopback origin of this DSH) for webhook sources. */
  webhookUrl?: string
  /** e.g. `whsec_ab…9f`; null when the source has no secret. */
  secretHint: string | null
  lastRun: RunRow | null
}

/**
 * One row per runId (the jsonl log may hold several lines for a runId; the latest wins).
 * pending = accepted, delivery in progress; queued = waiting for a busy reuse-mode chat (becomes delivered on flush).
 */
export type RunStatus = 'pending' | 'queued' | 'delivered' | 'skipped' | 'failed' | 'rejected'

export interface RunRow {
  runId: string
  automationId: string
  automationName: string
  at: number
  source: SourceKind
  /** Event id used for de-duplication (delivery id header, file path+mtime, composio event id). */
  eventId: string
  /** Short human description: `POST from 127.0.0.1 (github: push)`, `transcript.md in 2026-11-16-ab12`. */
  summary: string
  bytes: number
  status: RunStatus
  /** skipped/rejected reason: duplicate | disabled | paused | rate-limited | min-interval | filtered | bad-signature | ... */
  reason?: string
  sessionId?: string
  model?: string
  error?: string
  /** true when fired from the page's "Test" button. */
  test?: boolean
}

export interface TriggersState {
  paused: boolean
  automations: AutomationView[]
  runs: RunRow[]
  /** Origin used to build webhook URLs (DSH web server). */
  origin: string
  /** Whether optional companions are present. */
  hasAutomationModels: boolean
  hasComposio: boolean
  /** Workspaces offered in the editor. */
  workspaces: { path: string; title: string }[]
  defaultCwd: string
}

/** Body of POST /api/triggers/save. `secret` is never accepted from the browser: the host generates it. */
export interface SaveRequest {
  id?: string
  name: string
  description?: string
  enabled?: boolean
  source: Source
  target: Omit<Target, 'sessionId'>
  prompt: string
  limits?: Partial<Limits>
  maxEventChars?: number
}

/** Response of save / rotateSecret: the full secret is returned exactly once. */
export interface SaveResponse { automation: AutomationView; secret?: string; warnings: string[] }

export const API_BASE = '/api/triggers'
/** Public webhook ingress path: POST {HOOK_BASE}/<automation-id>. Not under /api so the browser-session auth fence does not apply; requests authenticate with the automation's secret instead. */
export const HOOK_BASE = '/hooks'

export const DEFAULT_LIMITS: Limits = { maxPerHour: 12, minIntervalSec: 10 }
export const DEFAULT_MAX_EVENT_CHARS = 12_000
export const GLOBAL_MAX_PER_HOUR = 60
export const MAX_BODY_BYTES = 1024 * 1024

# dsh-triggers — design (v0.1)

Hermes-style event automations for DSH: **an event happens → a chat opens (or wakes) with a prompt built from the event.**
One sidebar page ("Triggers") lists every automation, its source, its webhook URL, its last runs, and links to the chats it created.

Shared data model: [`src/shared/types.ts`](../src/shared/types.ts) (the contract between host and browser; change it only via the lead).

## Why a new plugin (research 2026-11-16)

| Existing | Why not used as-is |
|---|---|
| `@deepseek-ai/dsh-webhook` (+ `-github`) | Official runtime, but rules are code-only (no UI, no storage), fire-and-forget, no dedupe, GitHub-only adapter. Peers pinned to exact rc. |
| `dsh-trigger-hub` (vaniawang, MIT) | Closest shape (webhook/file/schedule → session) but config-file only (restart to change), no model choice, raw payload pasted into the prompt, read-only page. **Ideas borrowed:** source/sink split, `fire()` ledger, dedupe window, settle/debounce for watches. |
| `dsh-plugin-admin` | Webhook rules with UI, but a 1.9 MB nine-panel suite that rewrites the profile. |
| `omdsh-dev/dsh-webhook` + `cofy-x/dsh-automation` | Durable design, but only for DSH 0.1.x. |
| `@michengai/dsh-automation` | Excellent scheduled-task UI (0.2.x) but schedules only, no event triggers. |
| our `dsh-composio` | **Reused:** its launcher pattern (create session → workspace attach → sandbox → model → title → followup → flush), untrusted-event fencing (`prompt.ts`), rate limiting, automation-models source registration. |

## Sources

| Kind | How it fires | Event id (dedupe) |
|---|---|---|
| `webhook` | `POST /hooks/<automationId>` on the DSH web server (loopback :3080; also reachable on the tailnet via `tailscale serve`). Auth per automation: `token` (Bearer / `X-Trigger-Token`), `hmac-sha256` (`X-Hub-Signature-256`, GitHub), `standard-webhooks` (`webhook-id/-timestamp/-signature`, 5-min tolerance), `none` (loopback only). Body ≤ 1 MiB, JSON or text. Optional event-type filter. | `X-GitHub-Delivery` / `webhook-id` / `X-Request-Id` / `Idempotency-Key`, else sha256(body) |
| `file` | Recursive `fs.watch` on `path`; a file whose **name** matches `pattern` fires once it has been quiet for `settleMs`. Optional `requireSibling` JSON condition (e.g. `metadata.json` `status == completed`). Startup + every 5 min a catch-up scan finds matches missed while DSH was down. Files present when the automation is created are baselined and never fire. | `realpath` of the file (fires once per file; a re-written file does not fire again) |
| `composio` | `ctx.triggers.ingest({ source: 'composio', triggerSlug, triggerInstanceId?, eventId, data })` — called by dsh-composio (phase 2). Matched by `triggerSlug` (+ instance id when set). | Composio event id |

## Target (where the run goes)

- `new`: a new chat per event in `cwd`'s workspace (canonical Workspace via the registry, so it appears in the sidebar under that workspace).
- `reuse`: one chat per automation, created on the first event; later events are delivered with `followup` (queued while it is busy, bounded 8, batched on idle).
- `model`: explicit route or the profile default; through `dsh-automation-models` when present (source kind `trigger`, key = automation id), else `agent.model.select` on new chats only. **Never** `sessionController.selectModel`.
- `sandbox`: `read-only` (default) or `workspace-write`; the session's mode is only ever tightened (`sandbox/mode` event), never loosened.
- `tools: 'read'` (default): while a trigger-started turn runs, a tool guard allows only read-only tools (`read`, `glob`, `grep`, `skill`, `read_image`, `todo_write`, `web_search`, `web_fetch`, `ask_user_question`). The guard is lifted for turns started by a human message, so the user can keep working in that chat normally. `standard`: no guard (sandbox + approvals still apply).
- Title: template rendered with the event (`Meeting: {{file.dirname}}`), max 120 chars.

## Prompt rendering (trusted vs untrusted)

The automation's `prompt` is the only trusted text. Event data is JSON-stringified, truncated to `maxEventChars`, `<`/`>`/U+2028/2029 escaped, and placed inside `<untrusted_event>…</untrusted_event>`; a header tells the model never to follow instructions inside it. `{{event.a.b}}` inserts one field as an escaped JSON string literal (500 chars). File sources also expose `{{file.path}}`, `{{file.name}}`, `{{file.dirname}}` (folder name), `{{file.dir}}` (folder full path) (trusted: they come from the watched path, not from file content). Single-pass substitution; unknown variables render empty. Missing `{{event_fenced}}` → appended at the end. (Port of dsh-composio `prompt.ts`.)

## Safety and limits

- Per automation: `maxPerHour` (default 12), `minIntervalSec` (default 10); global 60/hour; "Pause all".
- Auto-disable after 3 consecutive delivery failures (shown on the page).
- Duplicate event ids (last 2000, persisted) are dropped and logged as `skipped: duplicate`.
- Webhook secrets: generated on the host (`whsec_` + 32 random bytes base64), stored in `$DSH_HOME/triggers/secrets.json` (0600), shown in full exactly once (on create / rotate), afterwards only a hint. Constant-time comparison. Wrong auth → 401 and a `rejected` run row (rate-limited to 10 rows/min so a scanner cannot flood the log).
- Management routes `POST /api/triggers/*` re-check `connection.requestRejection(request)` (fail closed) and same-origin, exactly like dsh-composio. The `/hooks/*` ingress is outside `/api` and authenticates with the automation's secret only.
- No payload content is written to the run log (only ids, sizes, summary, decision, session).

## Storage (`$DSH_HOME/triggers/`)

- `automations.json` — `{ version: 1, paused, automations: Automation[] }`, atomic write, 0600.
- `secrets.json` — `{ [automationId]: secret }`, 0600.
- `runs.jsonl` — append-only `RunRow`, last 2000 kept in memory.
- `seen.json` — dedupe ids + file baselines `{ [automationId]: string[] }` (bounded).
- `queue.json` — reuse-mode events waiting for a busy chat (survives restart).

## Host routes (`POST /api/triggers/<method>`, JSON in/out, envelope `{ok:true,value}` / `{ok:false,error:{code,message}}`)

| method | body | value |
|---|---|---|
| `state` | `{}` | `TriggersState` |
| `save` | `SaveRequest` | `SaveResponse` (secret only on create) |
| `delete` | `{ id }` | `TriggersState` |
| `setEnabled` | `{ id, enabled }` | `TriggersState` (enabling resets `consecutiveFailures`) |
| `setPaused` | `{ paused }` | `TriggersState` |
| `rotateSecret` | `{ id }` | `SaveResponse` with the new `secret` |
| `test` | `{ id, payload? }` | `RunRow` — fires the automation with a sample event (`test: true`), bypassing rate limits but not dedupe of real ids |
| `preview` | `{ id?, draft?: SaveRequest, payload? }` | `{ prompt: string, title: string }` — the exact text the model would get |
| `runs` | `{ id?, limit? }` | `RunRow[]` newest first |
| `models` | `{}` | the session controller `modelCatalog()` |

## Agent tools (in every root session)

- `triggers_list` — automations with source, target, enabled, last run, webhook URL.
- `triggers_save` — create/update an automation from chat (same validation as the page; never returns the secret: tells the user to copy it from the Triggers page).
- `triggers_test` — fire one with a sample payload.

## Browser page

Sidebar entry **Triggers** (next to "Automation tasks") → main panel:
- Header: Pause all switch, **New automation** (templates: *Meeting summary (voxtype)*, *Generic webhook*, *GitHub webhook*, *Folder drop*, *Composio trigger*).
- List: name, source chip (Webhook / File / Composio), target (new chat / one chat), model, enabled switch, last run status + time, failures badge.
- Detail/editor: name, description, source fields (per kind), target fields (workspace select, mode, model select from catalog with "Profile default", sandbox, tools), prompt textarea with variable help, title, limits; **Preview prompt** (rendered with a sample event); **Test**; for webhooks a card with the URL, auth, a copyable `curl` example, secret shown once + Rotate.
- Runs: table of recent runs (time, automation, summary, status/reason, model, **Open chat** link via `ctx.uiWorkspace.openSession(id)`).
- Refresh on visibility change, no idle polling.

## Phase 2

- dsh-composio routes events with a Triggers automation (`ctx.triggers.ingest`) so Composio routes and webhooks share one page and log.
- Schedule source (or link to the built-in Automation tasks).
- Outbound delivery (post the result to a URL / Telegram) after the run.

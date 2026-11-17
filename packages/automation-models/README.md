# dsh-automation-models

Run scheduled tasks, sentinel wake-ups and other automations on a **cheaper model**, without touching the session's own model or the profile's global default.

- Default route for every automation source: `claude / claude-sonnet-5-5`, reasoning effort `low`.
- **Temporary**: the session's model is switched when the automation turn starts and restored when the agent goes idle (only if nobody changed it meanwhile).
- Per-source defaults and per-scheduled-task overrides on the **Automation models** page (sidebar). "Session's own model" opts a source or a task out.
- Other plugins register their own sources through a small host service (below).

Built for DSH `>=0.2.2-rc.1 <0.3.0-0`. English-only UI.

## How it works (verified against the 0.2.2-rc.3 sources)

| Step | Mechanism |
|---|---|
| Detect | global (untagged) `agent/inbox/claimed` listener, payload `{ agent, message, turn }`; acts when `message.source.kind` is a registered automation source |
| Switch | synchronous `agent.model.select(route)` inside the listener. The loop reads `agent.model.current()` right after `inbox.claim()` with no `await` in between (agent-loop `agent.ts` preStep), so the selection applies to exactly that turn's first step. A busy session only claims the reminder at the turn boundary, so a running user turn is never switched |
| Restore | `agent/status` -> `idle`: if `current()` still equals what we set, `select(previous)`. If the user picked another model meanwhile, it is left alone |
| Crash safety | a marker row `{previous, applied}` is stored while a temporary switch is active; `agent/created` with source `resume` undoes a switch a crash left behind |
| Never | `sessionController.selectModel`, because it also calls `agentDefaultModel.saveSelection()` and would rewrite the global default |

Each switch adds DSH's own short `[model changed: ...]` notice to the transcript (two per automation turn: switch and restore); that is core behaviour and cannot be suppressed from a plugin.

### Resolution order

`per-item override` -> `stored source default` -> `default passed to registerSource` -> built-in default (`claude/claude-sonnet-5-5`, `low`).
An explicit "Session's own model" at the item or source level stops the chain (no switch).
A candidate whose provider/model is not in the live catalog is skipped with a notice (page, "Recent notices", and the host log), so a stale override falls back to the next candidate; the last resort is the built-in default, and if even that is unavailable nothing is switched.

### Schedule specifics

The schedule task id is parsed from the reminder text (`schedule_id_json:` / `reminders_json:`) until dsh-schedule exposes it structurally (see `docs/upstream-dsh-schedule.md`). `[SCHEDULE CHANGE]` notices share the `schedule` source kind and are ignored. **Batch reminders** (several tasks due for one session at once, one message): the **first task in the batch decides the model**. Overrides of deleted tasks are pruned automatically after `schedule/changed`.

Sessions created by schedule targets `new` / `new_once` are the automation's own, but the temporary rule is the same everywhere (the model is restored at idle). Tick "Keep this model after the run" on a task override to opt out.

## Service for other plugins: `automationModels`

Provided on the host context as `ctx.automationModels` (declare `inject: ['automationModels']` or use `ctx.get('automationModels')` for a soft dependency).

```ts
interface Route { provider: string; model: string; reasoningEffort?: string }
interface SourceSpec {
  label: string                       // shown on the page
  defaultRoute?: Route                // used when the user stored nothing; else the built-in default
  keyOf?: (message) => string | string[] | undefined // key for per-item overrides (arrays: first wins)
  isRun?: (message) => boolean        // false for housekeeping messages sharing the kind
}
automationModels.registerSource(kind: string, spec: SourceSpec): () => void   // disposer; also auto-disposed with your plugin
automationModels.resolveFor(message): { kind, key?, route, via, restore, skipped } | undefined
automationModels.applyTo(agent, route, { restore?: 'idle' | 'never' }): boolean
automationModels.listSources(): { kind, label, builtin }[]
automationModels.resolve(kind: string, key?: string): Route | undefined   // for sources that make their own LLM calls (e.g. the skill reviewer)
```

`kind` must equal the `source.kind` of the messages your plugin creates, e.g.:

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { composio: { kind: 'composio' } & ContextFormed }
}
const message = createUserMessage({ content: [...], source: { kind: 'composio' } })

// in apply(ctx), with a soft dependency:
ctx.inject(['automationModels'], (c) => {
  c.automationModels.registerSource('composio', {
    label: 'Composio triggers',
    defaultRoute: { provider: 'claude', model: 'claude-haiku-5-5', reasoningEffort: 'low' },
    keyOf: (m) => triggerSlugOf(m),
  })
})
agent.followup(message)   // the claimed hook does the rest, no extra code
```

- `registerSource` replaces an earlier registration of the same kind; a built-in (`schedule`, `sentinel`) keeps its parsers unless you supply your own.
- Kinds `user`, `model`, `tool`, `system-prompt` are refused.
- Per-item overrides for non-schedule sources are stored by `(kind, key)` (written by the page's `setOverride` route); the page currently lists only scheduled tasks as items, source-level defaults for all sources.
- `applyTo` is for plugins that switch a model explicitly (before `agent.followup`); it follows the same temporary/restore rules and returns `false` if a switch is already active for the turn, the agent has no current route, or the route is already in use.

Built-in sources: `schedule` ("Scheduled tasks") and `sentinel` ("Sentinel wake-ups"; sentinel always wakes an existing session, so the switch is temporary there). The skill reviewer and dsh-composio register `skill-reviewer` and `composio`.

## Host routes

`POST /api/automation-models/{state,setEnabled,setDefault,setOverride}` (JSON). Every call re-checks `connection.requestRejection` (fail closed) and requires a same-origin `Origin` for the browser page. State lives in the storage domain `automation_models` (`~/.dsh/storages/automation_models.json`): tables `defaults`, `overrides`, `markers` and a global `{enabled}`.

## Develop

```sh
pnpm install
pnpm run check    # typecheck, oxlint, token lint, vitest, tsdown build, artifact check
dsh plugin --profile <profile> add "dsh-automation-models@link:$PWD"
# then restart DSH
```

- `src/host/core.ts`: pure logic (registry, resolution, switch/restore), fully unit-tested (`tests/core.spec.ts`).
- `src/host/store.ts`: storage-domain wrapper; `src/index.ts`: host wiring, service, routes.
- `src/client/`: the page (lazy chunk `client.views.js`), kit controls from `src/kit/` (a copy of dsh-kit/ui).

### Verification log (2026-11-14)

A dev session on `claude-haiku-5-5 low`; a 1-minute schedule task targeting that session. The session log shows, for each reminder: `model/selection` -> sonnet-5-5 low, the reminder, `request/header` with `claude-sonnet-5-5`, then `model/selection` back to haiku-5-5 low at idle. Global default untouched. Deleting the task pruned its override.

## Upstream asks

Drafts in `docs/`: [dsh-schedule](docs/upstream-dsh-schedule.md) (structured task id + `target.create.model`) and [dsh-sentinel](docs/upstream-dsh-sentinel.md) (per-watch model).

## License

MIT, see [LICENSE](LICENSE). UI controls in `src/kit/` are adapted from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek); see [NOTICE](NOTICE).

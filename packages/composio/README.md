# @t3labs/ohmydsh-composio

Composio for DSH: four agent tools over the Composio CLI, a **Composio** page (connections, tool browser, trigger routes, recipes, run log), and a realtime trigger listener that turns events into a new agent session or a wake of an existing one.

Built for DSH `>=0.2.2-rc.1 <0.3.0-0`, English UI. Uses the existing **Composio CLI login** (`~/.composio/composio`, `user_data.json`); the user key never leaves the host and is never logged, prompted or sent to the browser.

## Agent tools

| Tool | What |
|---|---|
| `composio_search` | use-case search -> tool slugs + connected toolkits |
| `composio_execute` | run a tool (`arguments` via stdin), `get_schema`, `dry_run`; big output spills to a file (path returned) |
| `composio_link` | returns a Connect URL for the USER to open; the agent cannot finish OAuth |
| `composio_status` | connected toolkits/accounts and their status |

Risk comes from Composio's tool tags (`readOnlyHint` = read, `createHint`/`updateHint` = write, `destructiveHint`, none = unknown). In an interactive session read-only tools run, everything else asks (standard approval flow).

## Trigger runs (restricted by construction)

`Route` (one trigger on one account) -> `Recipe` -> **new session** or **wake an existing session**.

- Event payload is JSON-stringified, truncated, `<`/`>` escaped and placed inside an `<untrusted_event>` fence; only the recipe template is trusted; single-pass templating.
- New session: sandbox pinned (`read-only` default), tools limited to `composio_*` + read-only file tools (guard), model from the recipe (or the automation default).
- **A Composio tool outside the recipe's allowlist pauses for your approval** (`approval/asked`, shown in the session and handled by dsh-notify-me's approval notification). Allowed: tools on `allowTools` (unless destructive), and read-only tools of `allowToolkits`.
- Existing session (**opt-in per route, with a persistent warning in the UI**): trigger payloads are third-party text, so the turn they start is restricted like a new-session run. A tool guard allows only `composio_*` and read-only file tools, the session sandbox is pinned to the recipe mode (never looser than the session already had), and the per-run approval policy applies. All of it lifts on the next human message in that session; a pin left by a crash is undone when the session loads. The batched followup gets the same treatment (strictest sandbox, intersection of allowlists). A route that was not acknowledged does not deliver. Delivery is a `followup` when idle; when busy the event is queued (max 8, drop-oldest) and delivered as one batched message on idle. Archived and subagent targets are refused. The user's model is only switched temporarily, through dsh-automation-models, if the recipe pins one.
- Limits: per route 6/h and 30 s min interval, global 30/h, circuit breaker after 3 consecutive failures, "Pause all". Duplicate event ids are dropped.
- Never calls `sessionController.selectModel`.

### Model
If **dsh-automation-models** is installed, source `composio` is registered (per-route overrides keyed by `routeId`); a recipe that pins its own model is not overridden. Without it, a new session gets the recipe model via `agent.model.select`, and an existing session's model is left alone.

## Realtime listener

Outbound Pusher socket on `private-cli-<project_id>` (no public URL, no tunnel). Verified against the live service (spike 2026-11-13):

- credentials `GET /api/v3.1/cli/realtime/credentials`; channel auth `POST /api/v3.1/cli/realtime/auth` returns `{auth, channel_data}`. **Give pusher-js only `{auth}`**: with `channel_data` Pusher signs `socket_id:channel:channel_data` and rejects it ("Invalid signature"). Tested in `tests/events.spec.ts`.
- event name `chunked-trigger_to_client`, envelope `{id,index,chunk,final}`; chunks are joined (bounds: 100 pending ids, index <= 1000, 60 s stale) into the V3 event `{id,type:"composio.trigger.message",metadata{trigger_id,trigger_slug,toolkit_slug,connected_account_id,...},data}`. V2/V1 are normalised too.
- One listener per `$DSH_HOME` (lease file `composio/listener.lease`, 30 s TTL); pusher-js reconnects itself; auth failure refetches credentials with 2..60 s backoff.
- Events sent while DSH is down are lost (the channel is not replayable).
- Trigger instances are Composio-side; identical configs are de-duplicated by Composio into ONE instance, so routes can share it (it is deleted with the last route). Instances with no route are listed under Triggers ("orphans"), never auto-deleted.

## State and routes

`$DSH_HOME/composio/recipes.json` (recipes + routes, atomic write, 0600) and `runs.jsonl` (append-only run log: ids, sizes, decision, session; **no payload content**). Host routes `POST /api/composio/*` re-check `connection.requestRejection` (fail closed) and same-origin.

## Develop

```sh
pnpm install
pnpm run check
dsh plugin --profile <profile> add "@t3labs/ohmydsh-composio@link:$PWD"
# then restart DSH
```

Source map: `src/host/{creds,api,cli,service,tools,risk,events,listener,prompt,store,launcher}.ts`, wiring in `src/index.ts`, page in `src/client/panel.tsx`.

## Known limits / follow-ups

- The CLI-spawn fallback listener (`composio listen`) is not implemented (the socket path works); catch-up of missed events is not implemented.
- No Gmail/Slack end-to-end test yet (GitHub issue trigger was used). Gmail is a 2-minute poll with Composio's managed app.
- Connections page never removes accounts (re-auth/add only), by design.
- MCP toggle and macOS local tools: not built.

## Licence

MIT, see [LICENSE](LICENSE). UI controls in `src/kit/` are adapted from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek); see [NOTICE](NOTICE). The Host bundles `pusher-js` (MIT).

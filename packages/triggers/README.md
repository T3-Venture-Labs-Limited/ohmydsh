# @t3labs/ohmydsh-triggers

Event automations for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH 0.2.x): **something happens → a chat
opens (or wakes) with a prompt built from the event.** One sidebar page, *Triggers*, lists every automation, its
source, webhook URL, last runs and links to the chats it created. Design notes: [docs/DESIGN.md](docs/DESIGN.md).

## Sources

| Source | Fires on | Notes |
|---|---|---|
| Webhook | `POST /hooks/<automation-id>` on the DSH web server | Auth per automation: bearer token (`Authorization: Bearer` / `X-Trigger-Token`), HMAC-SHA256 (`X-Hub-Signature-256`, GitHub), Standard Webhooks (`webhook-id/-timestamp/-signature`), or none (loopback only). Body ≤ 1 MiB. Optional event-type filter. Reachable from your tailnet at `https://<tailnet-host>/hooks/<id>` when DSH is served with `tailscale serve`. |
| File | A new file whose **name** matches a glob (`transcript.md`, `*.pdf`) in a watched folder, once quiet for *settle* seconds | Recursive watch plus a periodic catch-up scan. Files present when the automation is created never fire. Optional "sibling JSON field equals" condition. |
| Composio | A Composio trigger event (Gmail, Slack, GitHub, …) received by [dsh-composio](../composio)'s realtime listener | Pick a connected account and a trigger type on the page; the trigger instance is created in Composio on save and removed on delete (unless a Composio-page route still uses it). No public URL needed. |

Each automation targets either a **new chat per event** or **one chat** that every event is added to, in a chosen
workspace, with a model (or the profile default), file sandbox, tool set and title template.

## The Triggers page

- Header: **Pause all**, **Refresh**, **New automation** with templates — *Meeting summary (voxtype)*, *Generic webhook*,
  *GitHub webhook*, *Folder drop*, *Composio trigger* (needs dsh-composio), *Blank*.
- List: name, source, target summary (`New chat · Claude Sonnet 5.5 · read-only`), last run, failure count, enabled switch.
- Detail: source / target / prompt / limits editor, **Preview prompt** (the exact text the model receives),
  **Test** (fires the saved automation with a sample event), **Delete**; for webhooks a card with the URL, the auth
  scheme, a copyable `curl` example, the secret (shown once) and **Rotate secret**.
- Runs: time, automation, event summary, status (delivered / running / queued / skipped / failed / rejected) with the
  reason, model, and **Open chat**.
- No idle polling: the page refreshes when it becomes visible, after every change, and on Refresh.

## From a chat

Agents get `triggers_list`, `triggers_save` (create, or partial update with `id`), `triggers_test`,
`triggers_set_enabled` and `triggers_delete`. Secrets are never returned to the model: the user copies them from the page.

## Sending a webhook

```sh
curl -X POST "http://127.0.0.1:3080/hooks/<automation-id>" \
  -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d '{"type":"deploy","service":"billing-api","status":"failed"}'
# 202 {"accepted":true,"runId":"run_…"}   401 bad secret   404 unknown/disabled   200 {"duplicate":true}   429 rate limited
```

The same id header (`X-GitHub-Delivery`, `webhook-id`, `X-Request-Id`, `Idempotency-Key`) is delivered once. Other
machines on your tailnet use `https://<tailnet-host>/hooks/<id>`; DSH stays tailnet-only (no Funnel), so for SaaS
senders that need a public URL, relay through Composio or a tunnel you control.

## Security model

- **Trusted vs untrusted.** Only the automation's prompt is trusted. Event data is JSON-stringified, truncated, escaped
  and wrapped in `<untrusted_event>…</untrusted_event>`; `{{event.<field>}}` inserts one field as an escaped JSON
  string. File path variables come from the watched path, not from file contents.
- **Least privilege by default.** Runs default to a read-only file sandbox and a read-only tool set while the
  trigger-started turn runs; the session sandbox is only ever tightened.
- **Webhook secrets** are generated on the host, stored in `$DSH_HOME/triggers/secrets.json` (0600), shown in full
  once (on create / rotate) and then only as a hint; compared in constant time. `none` accepts loopback requests only.
- **Management routes** (`POST /api/triggers/*`) require the browser session and same origin; the `/hooks/*` ingress
  authenticates with the automation's secret only.
- **Limits.** Per-automation max runs per hour and minimum interval, a global hourly cap, duplicate-event suppression,
  auto-disable after 3 consecutive failures, and **Pause all**. Payload content is never written to the run log.

## Install from source

```sh
pnpm install
pnpm run check                                   # typecheck + lint + token lint + tests + build
dsh plugin --profile <profile> add "@t3labs/ohmydsh-triggers@link:$PWD"
# then restart DSH
```

Remove with `dsh plugin --profile <profile> remove @t3labs/ohmydsh-triggers`. Never link before `pnpm run build` passes: a missing
client bundle can stop DSH from starting.

## Layout

- `src/index.ts`, `src/host/` — host half: storage, sources, launcher, routes, agent tools.
- `src/client/` — browser half. `index.tsx` registers only the sidebar entry and the dictionary; the page
  (`panel.tsx`, `editor.tsx`, `runs.tsx`, `webhook-card.tsx`) is the lazy `client.views.js` chunk.
  `model.ts` holds the pure logic (templates, draft ↔ `SaveRequest`, curl examples).
- `src/shared/types.ts` — the host ↔ browser contract.
- `src/kit/` — source copy of the dsh-kit controls (plus `TextArea` and grouped `Select` options).
- `tools/token-lint.mjs` — fails on `--dsw-*` tokens the theme does not define and on literal colours.

English-only UI behind the typed `t()` in `src/client/locale.ts`.

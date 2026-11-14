# dsh-pwa

Installs DeepSeek Harness as an app and adds a light phone view. English-only UI, no runtime dependencies in the page.

| Route | Auth | What it does |
|---|---|---|
| `GET /manifest.webmanifest` | public (browsers fetch it without credentials; no secrets inside) | Replaces the stock manifest: same icons, `start_url: /m`, `scope: /`, shortcuts, `share_target` |
| `GET /sw.js` | public | Service worker (see below); `Service-Worker-Allowed: /`, never cached by the browser |
| `GET /m`, `/m/app.js`, `/m/app.css` | signed in | The phone page: sessions, a session (read + reply, stop), approvals |
| `POST /share` | signed in, same-origin | Android share target. Saves text, url and files, answers `303 /m?share=<id>` |
| `GET /share?id=` | signed in | The stored share, read by `/m` |

Routing was verified in `dsh-host-webserver`: the match order is **exact route, then longest prefix, then the one SPA fallback seat**, and a duplicate `(kind, path)` registration throws, so these routes win over the SPA fallback and cannot silently shadow another plugin. `/m` is a prefix route; the others are exact.

## Auth and safety

- `/m`, `/share` call `connection.requestRejection(request)` first (Host/Origin fence + the same HttpOnly cookie as the full UI) and fail closed with 401/403. `POST /share` additionally requires a same-origin `Origin` (or `Sec-Fetch-Site: same-origin|none`).
- The `/m` page talks to the same `/api/<namespace>/<method>` HTTP RPC and one `/api/remote.mux` WebSocket as the full UI. It sees exactly what you see in the full UI; there is no extra permission surface. Approvals use the `$events` stream: a second answering client receives the same `approval/request` waterfall as the full UI, and whichever answers first settles it. `/m` passes every other waterfall on (`next`).
- Share records are stored under `$DSH_HOME/plugin-data/dsh-pwa/shares/<id>.json`; shared files go to `<share.cwd>/.dsh-shares/<id>/` when `share.cwd` is set (so a sandboxed agent can read them), otherwise next to the record. Files are `0600`, names sanitised to one path segment, size and file-count capped (`share.maxMiB`, default 25), and deleted after 7 days.
- Which messages show (same rule as the full UI's chat): a `user/message` is the person's own only when `source.kind === "user"`; everything else the host injects (runtime-context, skill-catalog, time-context, model-selection notices, composio, retry, ...) is context and is never a bubble. The page shows human messages, assistant text, and each tool call as "Used <tool>" (`public/m/events.js`, unit-tested on recorded events in `tests/fixtures/`).
- The page uses `textContent` only; no `innerHTML`, no inline script or style, no secrets embedded.

## The service worker never caches anything private

It answers only `GET` requests for public, content-addressed files: hashed `/assets/*-<hash>.js|css`, plugin bundles requested with `?rev=`, `/m/*?v=` and the install icons. For everything else (`/api`, `/plugins/events`, `/abx/*`, `/browser/*`, `/share`, `/m` documents, `/`, the manifest, `/sw.js`) it does not call `respondWith`, so the browser handles the request exactly as without a worker. Navigations are network-first and never stored (an offline page is shown on failure). It also refuses to store any response with `Set-Cookie`, `Cache-Control: no-store|private`, `Vary: *`, non-200 or non-same-origin status, or any request carrying `Authorization`. Caches are versioned and old ones deleted on activate. `serviceWorker: false` serves a kill-switch script that unregisters the worker and clears `dsh-pwa-*` caches. Policy is unit-tested in `tests/sw.spec.ts` against the real worker source.

The worker is registered from the host index through a structured `webserver/index-inject` row (a script appended to the body), so no client plugin has to write into the document. It only registers in a secure context.

## Config (`cordis.patch.yml`)

```yaml
- id: dsh-pwa
  name: dsh-pwa
  config:
    name: DeepSeek Harness
    shortName: DSH
    startUrl: /m          # or / for the full UI
    serviceWorker: true
    share:
      enabled: true
      cwd: ""             # workspace directory for sessions started from a share (shared files are saved in its .dsh-shares/); empty = the DSH default workspace
      mode: draft         # draft: pre-fill the composer, you press Send. session: send the shared content as the first prompt
      maxMiB: 25
```

## Install

1. Open DSH over HTTPS (for example with Tailscale: enable HTTPS for your tailnet, then `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, where `<port>` is the port DSH listens on) or on `localhost`. Plain `http://` to a non-local host is not a secure context: Chrome will not install it and ignores the worker.
2. Open the DSH link with its token once on the phone, then Chrome menu > **Install app**. Open `/m` to check the phone view.

## Notifications without an app store

`dsh-notify-me` can forward reminders to a **custom webhook** (`{source, event, title, body, text, sessionId, time}` as JSON). Run [ntfy](https://ntfy.sh) on your tailnet, point the custom webhook at `https://<host>/<topic>` and install the ntfy Android app. A raw JSON POST to ntfy shows as the message body; for a nicer title, use ntfy's `X-Title` header through a tiny relay, or use Gotify, which notify-me supports directly. Browser Web Push needs a push service and is not implemented here.

## Develop

`pnpm install && pnpm run check` (typecheck, oxlint, token lint, vitest, build, artifact + public checks). Layout: `src/host/` (routes), `public/m/` (phone page, served as-is), `src/client/` (Settings page), `src/kit/` (dsh-kit UI copy).

## Not verified

Installation and the share sheet on a real Android phone, over Tailscale HTTPS. Everything else was checked on `127.0.0.1` (a secure context): manifest, service worker, installability and the `/m` page at 393x851.

## Licence

MIT, see [LICENSE](LICENSE). UI controls in `src/kit/` are adapted from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek); see [NOTICE](NOTICE).

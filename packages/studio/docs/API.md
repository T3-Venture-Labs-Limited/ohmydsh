# Dsh Studio host API (v2) — frozen contract for the client

Status: **stable** (additive changes only).
Types live in [`src/v2/contracts.ts`](../src/v2/contracts.ts) (import them in the client with `import type`; they have no runtime deps).
Every example below is a real response captured from the running route handlers (`tests/v2/routes.spec.ts` exercises each route).

## Conventions

- Base path: `/plugins/dsh-studio/v2` (constant `ROUTE_BASE` in `src/v2/routes/http.ts`). Same origin as the DSH page: use relative URLs and `credentials: 'same-origin'`.
- Requests/responses are JSON (`content-type: application/json`) except media bytes and SSE.
- **Mutations** (POST/PATCH/DELETE) are rejected with `403 {"error":"origin-rejected"}` unless same-origin. Reads are not origin-checked but go through DSH connection admission like every plugin route.
- Errors: `{ "error": "<code>", "message"?: "<human text>" }`. Statuses: 400 invalid request / unsupported, 401 auth (provider key rejected), 402 quota/credits, 403 origin, 404 not found, 413 too large, 415 wrong content type, 502 provider failure. `error` for adapter errors is one of `auth|quota|moderation|invalid|unavailable|timeout|unsupported|unknown`.
- Ids: assets are 26-char sortable ids (`01M7…`), jobs are `job_<same format>`. Model ids are `provider:remoteId`, e.g. `openrouter:google/veo-3.1-fast`.
- Times are Unix epoch **milliseconds**. Money is **USD**; costs are estimates until `costSource` is `"provider"`.
- No polling: job progress and new assets arrive on the Typert stream `dshStudio/jobs` (DSH's multiplexed Remote WebSocket; there is no HTTP stream). Never poll `/jobs` on a timer.
- Media bytes are only ever served by asset id (no paths leave the host). Responses carry `x-content-type-options: nosniff` and a locked-down CSP.

## Models and providers

### `GET /models?capability=&provider=&configured=1&refresh=1`
`capability` is one of `t2i i2i inpaint upscale-image t2v i2v v2v extend upscale-video first-last-frame`. `configured=1` hides models of providers without a key. `refresh=1` re-fetches provider catalogs (otherwise cached 24 h).
Returns `{ "models": ModelDescriptor[] }`. The client builds its controls from `params` (enum/number/integer/boolean/text, with `default`, optional `when` gate) and `inputs` (how many images/videos and in which roles), never from provider names.
```json
{
  "models": [
    {
      "id": "openrouter:google/gemini-nano-banana-2.1",
      "provider": "openrouter",
      "remoteId": "google/gemini-nano-banana-2.1",
      "label": "Nano Banana 2.1",
      "capabilities": [
        "t2i",
        "i2i"
      ],
      "tier": "value",
      "inputs": {
        "images": {
          "max": 14,
          "roles": [
            "ref",
            "source"
          ]
        }
      },
      "params": [
        {
          "key": "aspect_ratio",
          "label": "Aspect ratio",
          "type": "enum",
          "values": [
            "1:1",
            "16:9"
          ],
          "default": "1:1"
        },
        {
          "key": "n",
          "label": "Images",
          "type": "integer",
          "min": 1,
          "max": 4,
          "default": 1
        }
      ],
      "pricing": {
        "unit": "image",
        "usd": 0.0336
      },
      "async": "sync",
      "curated": true,
      "verifiedAt": "2026-11-13"
    }
  ]
}
```

### `GET /providers`
`{ "providers": [{ "id": ProviderId, "configured": boolean, "label"?, "keyRef"?, "getKeyUrl"?, "covers"? }] }` — never contains keys. For `openrouter`, `replicate` and `google` the extra fields tell the settings card how to render a key row: store the key with the DSH credentials service under `keyRef` (the existing card already does this for the other providers via `props.credentials.set(ref, value)`), link to `getKeyUrl`, show `covers` as the hint. After a key changes, re-read `GET /providers` (credentials are re-resolved on every call; no restart needed). An environment variable with the same name also counts as configured.
```json
{
  "providers": [
    {
      "id": "openrouter",
      "configured": true
    }
  ]
}
```

## Jobs

`JobView` (list, SSE, create responses): `id, state, op, modelId, provider, createdAt, updatedAt, startedAt?, finishedAt?, progress? (0..1), message?, error? {kind, message}, assetIds[], origin ("ui"|"agent"|"import"), prompt, estimateUsd?, costUsd?, costSource? ("provider"|"estimate"), attempt`.
`state` is one of `queued submitting running finalizing succeeded failed canceled needs_attention`. **needs_attention** means the user must act (bad key, no credits): show a call to action, then `retry`.

### `POST /estimate` — validate and price without spending
Body: an `OperationRequest` (below). Returns `{ ok, configured, issues: [{path, message}], estimateUsd?, model? {id,label,async} }`. Use it live while the user edits the composer.
```json
{
  "ok": true,
  "configured": true,
  "issues": [],
  "estimateUsd": 0.0336,
  "model": {
    "id": "openrouter:google/gemini-nano-banana-2.1",
    "label": "Nano Banana 2.1",
    "async": "sync"
  }
}
```
Invalid example (`ok:false`):
```json
{
  "ok": false,
  "configured": true,
  "issues": [
    {
      "path": "op",
      "message": "Nano Banana 2.1 cannot do inpaint (needs inpaint)"
    }
  ],
  "estimateUsd": 0.0336,
  "model": {
    "id": "openrouter:google/gemini-nano-banana-2.1",
    "label": "Nano Banana 2.1",
    "async": "sync"
  }
}
```

### `POST /jobs` — submit (202)
Body = `OperationRequest`:
```ts
{ op: 'generate'|'edit'|'inpaint'|'upscale'|'animate'|'restyle'|'extend',
  modelId: string, prompt?: string, negativePrompt?: string,
  inputs: { source?, references?: string[], mask?, firstFrame?, lastFrame?, video? },  // each value is an asset id (or {assetId})
  params: Record<string, string|number|boolean>,   // keys/values from the model's ParamSpec list; defaults are applied host-side
  tags?: string[] }
```
Validation runs before anything is persisted or spent; failures return 400 with `message`. Response `{ "job": JobView }` with `state:"queued"`.
`GET /jobs/:id` returns `{ "job": JobView, "request": OperationRequest }` (the request is what "Open in composer"/"Retry with edits" reloads):
```json
{
  "job": {
    "id": "job_01M7B1P2WZJ6AZYAKFZCT2P0ZY",
    "state": "succeeded",
    "op": "generate",
    "modelId": "openrouter:google/gemini-nano-banana-2.1",
    "provider": "openrouter",
    "createdAt": 1794593459103,
    "updatedAt": 1794593459123,
    "startedAt": 1794593459103,
    "finishedAt": 1794593459123,
    "progress": 1,
    "assetIds": [
      "01M7B1P2XKDHD8KTCEYHSYVMTR"
    ],
    "origin": "ui",
    "prompt": "a small red paper boat on calm blue water",
    "estimateUsd": 0.0336,
    "costUsd": 0.0336,
    "costSource": "provider",
    "attempt": 1
  },
  "request": {
    "op": "generate",
    "modelId": "openrouter:google/gemini-nano-banana-2.1",
    "prompt": "a small red paper boat on calm blue water",
    "inputs": {},
    "params": {
      "aspect_ratio": "1:1",
      "n": 1
    },
    "tags": [
      "boat"
    ],
    "origin": "ui"
  }
}
```

### `GET /jobs?state=running,queued&limit=100` → `{ "jobs": JobView[] }` (most recently updated first)
### `POST /jobs/:id/cancel` → `{ "job": JobView }`; `POST /jobs/:id/retry` → 202 `{ "job": JobView }` (a **new** paid submission of the same request; only for failed/canceled/needs_attention jobs)

### Live stream `dshStudio/jobs` — Typert stream (push, no polling)

Formerly `GET /jobs/stream` (SSE), removed: an EventSource holds one of the browser's 6 HTTP/1.1 connections per host for its whole life. The frames below are now items of the stream (`{ event, data }`) opened through `ctx.remote.dshStudio.jobs()` on `/api/remote.mux`.
First frame is a snapshot of active jobs, then one `job` event per state/progress change, Reconnects (and a page returning from hidden) open a new generation that starts with a fresh snapshot.
```
event: snapshot
data: {"jobs":[]}

event: job
data: {JobView}
```

## Assets

`AssetRecord`: `id, sha256, kind ("image"|"video"), ext, mime, bytes, width?, height?, durationMs?, fps?, hasAudio?, codec?, posterSha?, createdAt, source ("generated"|"import"|"render"|"derived"), jobId?, op?, provider?, modelId?, prompt?, negativePrompt?, params?, seed?, costUsd?, title?, favorite, rating? (0..5), deletedAt?, sessionId?, workspacePath?, notes?, tags[]`.

### `GET /assets?q=&kind=&tag=&model=&provider=&favorite=1&collection=<collectionId>&parent=<assetId>&since=&until=&limit=60&offset=0`
`q` is full-text over prompt, title, tags and notes (prefix matching, any language). Newest first. Returns `{ "items": AssetRecord[], "total": number }` (`total` ignores limit/offset; limit is clamped to 1..500).
```json
{
  "items": [
    {
      "id": "01M7B1P2XKDHD8KTCEYHSYVMTR",
      "sha256": "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77",
      "kind": "image",
      "ext": "png",
      "mime": "image/png",
      "bytes": 70,
      "createdAt": 1794593459123,
      "source": "generated",
      "favorite": false,
      "tags": [
        "boat"
      ],
      "width": 1,
      "height": 1,
      "jobId": "job_01M7B1P2WZJ6AZYAKFZCT2P0ZY",
      "op": "generate",
      "provider": "openrouter",
      "modelId": "openrouter:google/gemini-nano-banana-2.1",
      "prompt": "a small red paper boat on calm blue water",
      "params": {
        "aspect_ratio": "1:1",
        "n": 1
      },
      "seed": 7,
      "costUsd": 0.0336
    }
  ],
  "total": 1
}
```
### `GET /assets/:id` → `{ asset, parents: AssetEdge[], children: AssetEdge[], collections: string[] }` (`collections` = ids of the collections containing the asset)
`AssetEdge = { childId, parentId, role: "source"|"reference"|"mask"|"first_frame"|"last_frame"|"video"|"upscale-of"|"extend-of", ord }`.
```json
{
  "asset": {
    "id": "01M7B1P2XKDHD8KTCEYHSYVMTR",
    "sha256": "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77",
    "kind": "image",
    "ext": "png",
    "mime": "image/png",
    "bytes": 70,
    "createdAt": 1794593459123,
    "source": "generated",
    "favorite": false,
    "tags": [
      "boat"
    ],
    "width": 1,
    "height": 1,
    "jobId": "job_01M7B1P2WZJ6AZYAKFZCT2P0ZY",
    "op": "generate",
    "provider": "openrouter",
    "modelId": "openrouter:google/gemini-nano-banana-2.1",
    "prompt": "a small red paper boat on calm blue water",
    "params": {
      "aspect_ratio": "1:1",
      "n": 1
    },
    "seed": 7,
    "costUsd": 0.0336
  },
  "parents": [],
  "children": []
}
```
### Media bytes
- `GET /assets/:id/file` — the original, `Accept-Ranges: bytes` (Range requests supported: use it directly as `<img src>` / `<video src>`; immutable, cacheable for a year).
- `GET /assets/:id/thumb?w=320` — WebP thumbnail (64..1024) for images; the poster JPEG for videos.
- `GET /assets/:id/poster` — video poster JPEG (404 for images).
### `PATCH /assets/:id` — `{ title?: string|null, favorite?: boolean, rating?: 0..5|null, notes?: string|null }` → `{ asset }`
```json
{
  "asset": {
    "id": "01M7B1P2XKDHD8KTCEYHSYVMTR",
    "sha256": "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77",
    "kind": "image",
    "ext": "png",
    "mime": "image/png",
    "bytes": 70,
    "createdAt": 1794593459123,
    "source": "generated",
    "favorite": true,
    "tags": [
      "boat"
    ],
    "width": 1,
    "height": 1,
    "jobId": "job_01M7B1P2WZJ6AZYAKFZCT2P0ZY",
    "op": "generate",
    "provider": "openrouter",
    "modelId": "openrouter:google/gemini-nano-banana-2.1",
    "prompt": "a small red paper boat on calm blue water",
    "params": {
      "aspect_ratio": "1:1",
      "n": 1
    },
    "seed": 7,
    "costUsd": 0.0336,
    "title": "Paper boat",
    "rating": 4
  }
}
```
### `DELETE /assets/:id` → `{ ok: true }` (soft delete; hidden everywhere; files purged after 30 days when no other asset shares the bytes)
### `POST /assets/:id/tags` — `{ add?: string[], remove?: string[] }` → `{ tags: string[] }` (lowercased, max 40 chars)
### `GET /assets/:id/lineage` → `{ nodes: AssetRecord[], edges: AssetEdge[] }` — the whole connected component (ancestors and descendants), capped at 200 nodes
### `POST /assets/import?title=&tags=a,b` — body = **raw bytes**, `Content-Type: image/*|video/*` → 201 `{ asset }`
Bytes must be a recognised image/video (checked by magic bytes, not the header); up to 512 MB. Use this for drag-and-drop, paste, and masks painted in the client (export the mask as PNG; **white = area to change**; the host inverts for models that need the opposite).

## Collections, tags, spend, stats
- `GET /collections` → `{ collections: [{id,name,count}] }`; `POST /collections {name}` → 201 `{id,name}`; `POST /assets/:id/collections {add?: collectionId, remove?: collectionId}` → `{ok:true}`.
- `GET /tags` → `{ tags: [{tag,count}] }`
- `GET /spend?since=<ms>` → `{ spend: [{day:"YYYY-MM-DD", provider, usd, count}] }` (sum of recorded asset costs; recorded costs are `provider`-reported when available, otherwise estimates)
- `GET /stats` → `{ count, bytes, images, videos }`

## Additions after the first freeze (all additive)

### Live asset events
The `dshStudio/jobs` stream now also emits `{ event: 'asset', data: AssetRecord }` whenever any asset is committed (generation, `/assets/import`, render import, agent tools). Use it to update the gallery without polling; de-duplicate by `id` (a job's `succeeded` event and its asset events can arrive in either order).

### ZIP export — `GET /assets/zip?ids=a,b,c` or `POST /assets/zip {ids:[…]}`
Streams `application/zip` (stored, ZIP64-capable) with `Content-Disposition: attachment; filename="studio-<n>-assets.zip"`. Entry names are `<id>-<slug-of-title-or-prompt>.<ext>`. Max 500 assets and 4 GB per archive (400 `too-many-assets`, 413 `archive-too-large`); 404 if any id is unknown or deleted. Use `GET` with an `<a download>` link for small selections; `POST` (same-origin `fetch`, then a blob URL) for large ones.

### Model examples — `GET /models/examples?modelId=replicate:owner/name`
`{ available: boolean, examples: [{ title?, summary?, pageUrl, thumbUrl?, input? }] }`. `available:false` (and an empty list) when there is no Replicate token or the model is not a Replicate model. Results are cached for 1 h. `thumbUrl` is a `replicate.delivery` URL: hotlink it, never store it. Inline `data:` inputs are stripped.

### HyperFrames hand-off
The host spawns the HyperFrames CLI (`hyperframes preview <dir> --foreground --no-open --port <free>`) bound to `127.0.0.1`; projects live in `<DSH_HOME>/studio/hyperframes/<slug>/`. Telemetry and update checks are disabled for every child process. Previews are stopped after 30 min of no use and when the plugin unloads.
- `GET /hyperframes/status` → `{ available: boolean, cli?: string, projects: [{ slug, dir, running, port?, url? }] }`
- `POST /hyperframes/open {assetIds?: string[], project?: slug}` → `{ slug, url, loopbackUrl, port, created }` where `url === loopbackUrl === http://127.0.0.1:<port>/#project/<slug>`. **The preview binds to 127.0.0.1 only** (it has no authentication and serves the project folder, so it is never exposed on the network): the iframe works when the browser runs on the same machine as the DSH host. When DSH is opened from another machine (`location.hostname` is not `127.0.0.1`/`localhost`), do **not** rewrite the host (nothing listens there); show the URL with an "open on the host machine" note instead. Creates the project with `hyperframes init <slug> --example blank --non-interactive` (first video asset passed as `--video`, resolution preset from its shape), hard-links the assets into `<project>/assets/<assetId>.<ext>`, records `studio-lineage.json`, starts or reuses the preview and resolves once `/__hyperframes_config` answers (≤ 60 s). Errors: `503 hyperframes-missing` (CLI not installed; show install guidance, then call again), `400 invalid-slug`, `404 asset-not-found`, `502 hyperframes-init-failed|hyperframes-preview-failed`, `504 hyperframes-preview-timeout`.
- `POST /hyperframes/stop {slug}` → `{ stopped: boolean }`
- `POST /hyperframes/import-renders {slug}` → `{ assets: AssetRecord[] }`. Imports each finished file in `<project>/renders/` once (skips files modified in the last 2 s), as `source:"render"`, tags `render, hyperframes`, with `role:"video"` lineage edges to the project's clips. Idempotent: call it when the user returns to the gallery, on a "Import renders" button, or after the iframe reports a finished render. Also emits `asset` events.
Embed the returned `url` in an `<iframe>` (loopback pages are not frame-blocked) with an "open externally" link.

### Non-secret settings — `GET /settings`, `PUT /settings`
`{ settings: { "replicate.pinned": string, "hyperframes.cli": string, "hyperframes.npx": "0"|"1"|"" } }`. `PUT` takes any subset (same-origin only), validates each key and returns the full object. `replicate.pinned` is a space/comma separated list of extra Replicate slugs (`owner/name`) to expose as generic models; `hyperframes.cli` is an absolute path to the CLI (empty = use PATH); `hyperframes.npx` = `1` allows `npx -y hyperframes@0.9.41` as a fallback (downloads a package: ask the user first). Changing `hyperframes.cli` takes effect on the next `/hyperframes/status`.

## Task-20 additions (masks, outpaint) — all additive

### Masks — `POST /masks?source=<imageAssetId>`
Body = **raw PNG** (`Content-Type: image/png`, up to 64 MB) exported by the MaskEditor: **white = area to change**, any size (the host resizes with nearest-neighbour so edges stay crisp), or a transparent PNG whose opaque pixels are the strokes. Do **not** invert it for any model: the host inverts per model (`ModelDescriptor.maskPolarity`) and routes by `inpaintMode`.
Returns 201 `{ asset, stats: { width, height, editedFraction } }`. The stored asset has the exact size of the source, hard edges, tag `mask`, `source:"derived"`, and a lineage edge (`role:"source"`) to the source image. Show a warning when `editedFraction` is 0 (nothing painted) or above ~0.98 (use an edit instead): inpaint jobs refuse both with `400 invalid`. Errors: `404 source-not-found`, `415 png-required`, `400 invalid-mask`, `403`, `413`, `503` (image tooling unavailable).

### Inpaint — `POST /jobs` with `op:"inpaint"`
`inputs: { source: <imageAssetId>, mask: <maskAssetId> }`, `prompt` = what to paint in the area. Models with capability `inpaint` only. How the mask reaches the model is the host's business: `inpaintMode:"mask"` (mask image in the model's polarity), `"markup"` (transparent overlay, OpenRouter GPT Image) or `"overlay-prompt"` (tinted copy of the source plus an instruction). After the model answers, the host pastes the result back over the original outside the mask, so untouched pixels are bit-exact the source (`asset.params.composited === true`; if compositing is impossible the raw model output is stored). The result has lineage edges `source` and `mask`.

### Outpaint — `POST /assets/expand`
Body `{ assetId, top?, right?, bottom?, left?, overlap? }` (pixels; at least one side; each side ≥ 0; result ≤ 8192 px per side; `overlap` default 16 = how much of the old image next to the new area is repainted so the seam blends). 201 `{ image: AssetRecord, mask: AssetRecord, width, height }`: the expanded image (new area filled by edge replication, tag `outpaint`) and its mask (white = new area + overlap band, tag `mask`). Then submit `POST /jobs {op:"inpaint", inputs:{source: image.id, mask: mask.id}, prompt}` — that is the whole outpaint flow. Errors: `404 source-not-found`, `400 invalid-expansion`, `403`, `503`.

### Legacy import (dsh-image-gen gallery) — for the one-time "Import from Image Studio" button
The browser shim reads IndexedDB `dsh_image_gen_db` (store `gallery_history`; the records are `GalleryItem`) and `favorite_prompts`, and POSTs them in batches. The **host** reads the image bytes itself (from the DSH attachment store by `attachment` ref, and raw originals such as animated GIFs from the old vault), so the browser never uploads image data.
- `POST /import-legacy` body `{ items: LegacyItem[] (≤ 25), prompts?: [{id, text, addedAt?}] }` → `{ items: [{ id, status: "imported"|"skipped"|"missing"|"failed", assetId?, error? }], prompts: { imported, skipped }, linked }`. Send the **fields as stored**: `id, attachment, prompt, provider, model, createdAt, isFavorite, tags, workspacePath, sessionId, sourceAttachmentIds, original, seed, aspectRatio, imageSize, resolution, generationQuality, output`. Idempotent: each legacy `id` maps to one asset, so re-running (or a second batch that overlaps) only imports what is new (`skipped`). `missing` = the file no longer exists anywhere (show the count, don't retry). Imported assets get tag `legacy`, their original creation time, favourite flag and tags; `provider:"import"` records become `source:"import"`; edit chains are rebuilt (`role:"source"` edges) across batches. Unknown providers are dropped, never trusted. 413 `batch-too-large` above 25 items.
- `POST /import-legacy/vault {limit?: number ≤ 200}` → `{ imported, skipped, remaining }`: imports raw originals found in `<DSH_HOME>/image-gen/vault` that no gallery record pointed to (tags `legacy, vault`). Call repeatedly until `remaining` is 0.
- `GET /import-legacy/status` → `{ vaultFiles, importedItems, vaultDirs }` (what is left in the old vault, how many gallery records are already imported).
Suggested client flow: read all records from IndexedDB → send in chunks of 25 with a progress bar → send favorite prompts once → call `/import-legacy/vault` until `remaining` is 0 → show the summary (imported / already there / missing).

## Agent media (images and videos agents make in any chat)

Studio watches the durable `session/event` feed. For every successful `tool/result` of a tool that is not one of Studio's own (`studio_*`) and not a viewer tool (`read*`, screenshots, browser tools, web tools): each `image` content part with an attachment is stored, and a line `Saved video to <path>` (video_generate) is imported when the path resolves, through symlinks, to a regular video file (`.mp4 .webm .mov .mkv`, ≤ 512 MB, recognised by its bytes) inside `<DSH_HOME>/plugins/subscriptions/{videos,images}` or the session's workspace. Network URLs are never fetched. Assets get `source:"agent"`, tags `agent` and the tool name, the call's `prompt`, `provider` and `model`, the `sessionId`, the session's `workspacePath` and `origin: { tool, provider?, model? }`. Content addressed: a file already in the gallery is "already there", and a hash that was collected once is never collected again (a deleted asset stays deleted). Gated by the setting `agent.capture` (`"0"` = off, anything else = on).

- `GET /assets?fromChats=1` → only assets that came out of a chat (`source:"agent"` or any asset with a `sessionId`). `GET /assets?source=agent` → only agent-collected media.
- `GET /assets/:id` additionally returns `chat: { id, title? }` when the asset has a `sessionId` (title read from the session log when the host can).
- `GET /agent-media/status` → `{ running, last: { imported, alreadyThere, skipped, failed, filesScanned, sessionsScanned?, at } | null, count }`.
- `POST /agent-media/backfill` → `{ summary }` (same shape as `last`). Reads existing chats' tool results (when the host exposes `sessionQuery`) and the subscriptions `images`/`videos` folders. Idempotent, single-flight, never moves or deletes a file. It also runs once automatically ~20 s after the first start with this version.
- `PUT /settings {"agent.capture":"0"|"1"}`.

## Rules the UI must follow
1. Build controls from `ModelDescriptor.params/inputs/capabilities`; hide a param whose `when` is unmet. `async:"job"` models (video) never block the UI: show the job card and follow the SSE stream.
2. Show `estimateUsd` before the user submits and `costUsd` (with `costSource`) after. No spend caps exist; do not invent any.
3. A job survives page reloads and host restarts: on load, call `GET /jobs?state=queued,submitting,running,finalizing,needs_attention` once, then follow SSE.
4. Inputs reference **assets**, never raw bytes. Upload first (`/assets/import`), then reference the id.
5. Use only `--dsw-alias-*` tokens from `tools/dsw-defined.txt`; run `node tools/token-lint.mjs src` before committing; build UI from `src/kit/` (dsh-kit).
6. English only, typed `t()`. Heavy views (lightbox, mask editor, graph) via dynamic `import()`; the lazy-chunk pattern is `src/client/workbench-loader.tsx` + a `LAZY_CHUNKS` row in `tsdown.config.ts`.

## Provider notes the UI should surface
- OpenRouter video inputs must be public HTTPS URLs: **upscale/restyle of a clip is only possible for clips OpenRouter generated in the last ~24 h** (the host remembers the signed URL); otherwise `POST /jobs` fails with `unsupported` and tells the user to use a Replicate model. Check this with `POST /estimate` first.
- Replicate and Gemini API keys may be missing: `GET /providers` shows `configured:false`; such models are listed with `configured=0` but cannot be submitted.
- Subscription providers (`grok-sub`, `google-sub`) are image-only and priced `$0 (included)`.

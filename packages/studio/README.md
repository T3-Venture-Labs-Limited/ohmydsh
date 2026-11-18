# @t3labs/ohmydsh-studio

A personal image and video studio for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH 0.2.2-rc.x): generate, edit,
inpaint, outpaint, upscale and animate, with a searchable library that remembers where every result came from.
Hard fork of [`shanliuling/dsh-image-gen`](https://github.com/shanliuling/dsh-image-gen) (Apache-2.0); see [NOTICE](NOTICE).

Status: **0.1.0**. Everything below is implemented and tested; what has only been tested against recorded responses (no live
key was available) is listed under [Verification status](#verification-status).

## What you get

- **Studio tab and library**: composer, gallery with search, favourites, tags, collections, lineage, ZIP export, job history
  with cost.
- **Operations**: generate (text, references, first/last frame), edit, inpaint, outpaint, upscale (image and video), animate,
  restyle and extend video.
- **Providers**: OpenRouter, Replicate, Google Gemini (key), Grok and Google subscriptions, OpenAI, OpenAI-compatible relays,
  xAI, local ComfyUI workflows. Models and their parameters come from the providers' own catalogs, so new models appear
  without a release.
- **Agent tools**: `studio_make`, `studio_models`, `studio_job`, `studio_gallery`. Attach an image in the chat and say what to change.
- **HyperFrames hand-off**: send clips and images to a HyperFrames project and import the finished renders back.
- **Honest costs**: estimate before, recorded cost after, no spending caps.

End-user guide (keys, flows, limits, prices): [docs/DETAIL.md](docs/DETAIL.md).

## Quick start

1. Install the plugin in your DSH profile and restart.
2. **Settings → Plugins → Dsh Studio**: add `OPENROUTER_API_KEY` (and optionally `REPLICATE_API_TOKEN`, `GEMINI_API_KEY`), or
   sign in to a subscription. Keys are stored with DSH credentials; the same names work as environment variables.
3. Open **Studio** in the right sidebar, or ask the agent for a picture.

## Costs and limits in one minute

Estimates are shown before every job and may be lower than the real bill (audio on video models is the usual surprise). There
is no spending cap. Video upscale/restyle of an OpenRouter clip works for about 24 h after generating it; Replicate output
links expire after an hour (results are downloaded immediately). Jobs survive restarts and are never sent twice. Details in
[docs/DETAIL.md](docs/DETAIL.md).

## Coming from dsh-image-gen

Studio runs next to the old plugin (own ids, routes, tools, credentials and storage). Use **Import from Image Studio** in the
library to copy your old gallery and vault, then follow [docs/RETIRE-IMAGE-GEN.md](docs/RETIRE-IMAGE-GEN.md) to remove it.

## Verification status

| Area | Status |
|---|---|
| OpenRouter images, edit, video, FLUX 3, GPT Image inpaint/outpaint | verified live, with recorded costs |
| Agent tool calls (edit a pasted image, batches), library lineage, workspace save | verified live in a dev session |
| HyperFrames project creation, loopback preview, render import | verified against the real CLI 0.9.41 |
| Replicate (all models), Google direct (Nano Banana, Gemini Omni) | tested against recorded responses only; needs a key to verify live |
| Video upscale through OpenRouter | request accepted; the provider never finished the job in our test |
| Legacy gallery import | host side tested (attachments and vault); the browser dialog needs an old IndexedDB gallery to try |

## Develop

```sh
pnpm install
pnpm run check      # typecheck + token lint + tests + build + artifact check
```

- Host half `src/index.ts` → `lib/index.js` (tools, HTTP API under `/plugins/dsh-studio/v2`, job runner, asset store on
  `node:sqlite`). Browser half `src/client/index.tsx` → `lib/client.js` (about 190 kB) plus one lazy chunk,
  `client.workbench.js` (the studio UI).
- Provider adapters live in `src/v2/providers/` behind one `ProviderAdapter` interface; add a provider by implementing it and
  registering it in `src/v2/wire.ts`. Contract tests use recorded fixtures in `tests/v2/fixtures/`.
- `src/kit/` is a source copy of `dsh-kit/ui`; new UI uses it. `tools/token-lint.mjs` fails on unknown theme tokens and on
  literal colours outside `artwork/` paths.
- The HTTP API is documented and drift-tested in [docs/API.md](docs/API.md).
- Live tests (they spend real money) are opt-in: `LIVE_OPENROUTER=1 npx vitest run --config vitest.live.config.ts`.

### Install from source

```sh
dsh plugin --profile <profile> add "@t3labs/ohmydsh-studio@link:$PWD"
# then restart DSH
```

Link only after `pnpm run build` has produced `lib/index.js`, `lib/client.js` and `lib/client.workbench.js`; a missing client bundle can stop DSH from starting.

## License

Apache-2.0. Original work (c) shanliuling and contributors; modifications (c) 2026 Superdao (deestax). See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

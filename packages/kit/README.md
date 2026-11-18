# @t3labs/ohmydsh-kit

Shared foundations for DeepSeek Harness (DSH) plugins: a **source-copied** React UI kit, a **token linter**, and a **plugin template**.
Nothing here is a runtime dependency: copy what you need into your plugin.

## UI kit (`ui/`)

Copy the directory to `src/kit/` in your plugin. Import from `./kit/index.ts`.

| Export | Notes |
|---|---|
| `Button` (`primary`/`ghost`/`outline`/`toolbar`/`danger`, `md`/`sm`), `IconButton` (required `label`) | `type="button"` by default |
| `Switch` | `role="switch"`, `aria-checked`, required `label` |
| `SegmentedControl` | WAI-ARIA tabs, arrow/Home/End, sliding indicator |
| `TextField`, `Select` | label, hint, error (`role="alert"`), native `<select>` |
| `Modal` | portal, focus trap + restore, Escape, mask click, `data-modal-autofocus` |
| `Tooltip` | hover/focus, side flipping, ignores post-click focus |
| `Page`, `Section`, `Card`, `SettingsRow`, `EmptyState` | settings/Plugin Manager page patterns |
| `defineLocale(ns, en)` | typed English dictionary over `ctx.locale` |
| `useKitStyles()` | ref-counted `<style data-dk-styles>`; Page/Modal/Tooltip/EmptyState call it for you |

Rules: classes are prefixed `dk-`; colours come **only** from `--dsw-*` tokens listed in `lint/dsw-defined.txt` (no literals).
Styles live in `ui/kit.css`, imported as `?inline` text and injected while a kit component is mounted (so disabling the plugin leaves no CSS).
Bundling: the template's tsdown config handles `*.css?inline`; React/ReactDOM are provided by the host module table.

## Token linter (`lint/token-lint.mjs`)

```sh
node ../kit/lint/token-lint.mjs            # scans src (strict) and lib (tokens only) in cwd
node ../kit/lint/token-lint.mjs src --tokens my-tokens.txt
```

Fails on: `--dsw-*` names not in `dsw-defined.txt`, dynamic `--dsw-…${}` names, and `#hex` / `rgb()` / `hsl()` literals outside artwork.
Artwork exemptions: path segment `artwork/` or `*.artwork.*`; `artwork:start` … `artwork:end` comment markers; `artwork:ok` on a line; `token-lint-disable-line`.
Refresh `lint/dsw-defined.txt` per DSH release from the installed `dsh-client-ui-theme` stylesheets.

## Plugin template (`template/` + `scripts/new-plugin.sh`)

```sh
scripts/new-plugin.sh <name> [--title "Title"] [--scope @scope] [--dir <parent>] [--no-install] [--no-git]
cd ../<name> && pnpm run check       # typecheck, oxlint, token lint, vitest, tsdown build, artifact check
```

Generates `<parent>/<name>` (default parent: the directory that contains this repository) with the kit copied to `src/kit/` and the linter to `tools/`, runs `pnpm install` and makes an initial git commit.

- **Build**: `tsdown` emits `lib/index.js` (Host, ESM) and `lib/client.js` (browser factory in the `window.__ModuleLoader__.load({id, factory})` format, mirroring the official `packages/client/tsdown.client.ts` preset). A source `import()` becomes `require.async("./client.<name>.js")`, a lazy chunk. Chunks must be self-contained, so the template routes every kit-using view through one lazy chunk, `client.views.js`.
- **Artifact gate**: `scripts/check-artifacts.mjs` runs inside `pnpm run build` and fails unless everything `package.json` declares exists (`exports`, `main`, `dsh.client` bundle, patch, locale, icon, detail doc), the `engines.dsh` range is right, `@deepseek-ai/*` is in both `peerDependencies` and `devDependencies`, and no chunk synchronously requires another. **Link into a profile only after `pnpm run build` succeeds**: a missing client bundle crash-loops the shared dev harness. `prepare` also runs the build, so a `link:`/git install builds first.
- **Client**: `apply(ctx)` registers an English dictionary (`ctx.locale`) and, via `ctx.slots.inject` + `ctx.slots.register`, a `settings.section` page, a `sidebar.panellist` icon and its `main` panel; views load lazily.
- **Demo**: the generated plugin renders a settings page (every kit control, a confirm Modal, tooltips) and a sidebar panel; `docs/DETAIL.md`, `docs/preview.svg` and `icon.svg` are placeholders to replace.
- Checks after each `systemctl --user restart dsh-dev`: `
## Conventions the template follows

1. One repository per plugin; install through `dsh plugin add` (for example with a `link:` spec), never by editing a profile's `node_modules`.
2. English-only UI behind a typed `t()`.
3. `@deepseek-ai/*` in both `peerDependencies` (`>=0.2.2-rc.1 <0.3.0-0`) and `devDependencies`; `engines.dsh: ">=0.2.2-rc.1 <0.3.0-0"`.
4. UI from this kit; no `require('@deepseek-ai/dsh-client-ui-primitives')`; React in slots, never iframes.
5. Heavy features load via dynamic `import()`; nothing heavy on the boot path.
6. No polling where a push channel exists; unavoidable polls are visibility-aware with backoff.
7. Host routes call `connection.requestRejection(request)` and fail closed.
8. Done = build + tests + token lint pass, checked in the browser (light and dark), `docs/DETAIL.md` + `icon.svg`, README.

## Licence

MIT, see [LICENSE](LICENSE). The controls in `ui/` were adapted from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek); see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Plugins generated from the template carry that notice in their own `NOTICE`.

## Push channel (`ui/push/`)

Copy to `src/kit/push/`. Browsers allow 6 HTTP/1.1 connections per host and every `EventSource` holds one for its whole life, so plugin push channels must not be HTTP streams. Use DSH's Typert gateway instead: one WebSocket per page (`/api/remote.mux`) carries any number of streams.

| File | Side | Role |
|---|---|---|
| `host.ts` | Host | `registerPushRemote` registers a hand-built Cordis service the gateway discovers in source mode (no generator, no runtime import of `dsh-typert-protocol`); `pushIterable` turns a subscription into the stream's `AsyncIterable` (snapshot first, bounded queue, ends with the signal). Method implementations must be plain functions whose parameter names are the wire fields, plus a trailing `signal`. |
| `transport.ts` | Client boot entry | `createPushTransport(ctx, { pkg, serviceKey, namespace, streams })` mounts the descriptors on `ctx.remote` and returns `stream(method, args, signal)`. Import it from the plugin's boot entry only. |
| `client.ts` | Client, any chunk | `subscribePush(source, listener, env?)`: one shared stream per id per page (window-level registry), opened only while a consumer is mounted **and** the page is visible, closed on hide/unmount, `onOpen` to resync, a slow (>= 15 s) `poll` while the stream cannot be opened, `onError` to give up on a permanent refusal. |

The Host plugin must also expose the service under a namespace nobody else uses (`dsh<Plugin>`), and the stream must apply the same authorisation as the plugin's HTTP routes (the gateway admits the peer at the WebSocket upgrade; a stream that takes a session id or path must still resolve and bound it like the RPC route does).

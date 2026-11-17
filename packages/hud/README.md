# dsh-hud

Host half of the DSH HUD: a Unix-socket JSON-RPC bridge that lets the [dsh-hud-qt](https://github.com/deestax/dsh-hud-qt) desktop popup list sessions, chat, switch the model and open a session in the web UI.

**Disabled by default.** Enable it only if you run the Qt HUD:

```yaml
- name: dsh-hud
  config:
    enabled: true
    # allowDangerousSessions: false   # default; see below
```

## Trust boundary

The socket lives at `$XDG_RUNTIME_DIR/dsh-hud-<hash of DSH_HOME>.sock` (mode 0600, DSH_HOME-scoped). Trust is **"same uid"**: any process of your user that can `connect()` to it is treated as the HUD. DSH's own sandbox (`bwrap --ro-bind / /`, Landlock) does not scope Unix sockets, so a process the agent runs inside a sandboxed session can reach it too. Therefore:

- The bridge never hands out credentials. `web/url` returns the **plain** advertised URL (no login token); the browser you open already holds the auth cookie.
- `session/prompt`, `session/select` and `session/create` **refuse sessions whose permission mode is `danger-full-access`** (and sessions that are not loaded, whose mode is unknown), and refuse to create sessions when new sessions would start in that mode. Set `allowDangerousSessions: true` only if you accept that anything running as your user can then drive an unsandboxed agent.
- `sessions/list` and `session/attach` (reading transcripts) remain available. A sandboxed process can already read the session logs from disk.
- At most 8 concurrent connections; frames are capped at 1 MiB; a non-socket file at the configured path is never deleted.

Upstream ask: scope Unix sockets in the sandbox (Landlock ABI 6 abstract-socket scoping, or a private `$XDG_RUNTIME_DIR` inside bwrap).

## Develop

```sh
pnpm install
pnpm run check          # typecheck + oxlint + token lint + tests + build + artifact check
```

- `src/index.ts`: Host half (`apply(ctx)`); register every resource with `ctx.effect` / `ctx.on`.
- `src/client/index.tsx`: browser half; registers slots with `ctx.slots.inject` + `ctx.slots.register`. Heavy views are loaded with lazy `import()` (emitted as `client.<name>.js` chunks).
- `src/kit/`: source copy of `dsh-kit/ui` (Button, Switch, SegmentedControl, TextField, Select, Modal, Tooltip, Page, Card, SettingsRow, EmptyState). Edit freely; do not add a runtime dependency on it.
- `tools/token-lint.mjs`: fails on `--dsw-*` names the theme does not define and on literal colours outside artwork. Update `tools/dsw-defined.txt` per DSH release.
- UI strings live in `src/client/locale.ts` (English dictionary, typed keys).

## Build output

`pnpm run build` emits `lib/index.js` (Host) and `lib/client.js` (+ lazy chunks `lib/client.*.js`) and then runs `scripts/check-artifacts.mjs`, which fails unless every file declared in `package.json` (`exports`, `dsh.client`, `dsh.bundle.patch`, locale, icon, detail document) exists. A missing client bundle crash-loops the dev harness, so never link a plugin into a profile before the build passes.

## Install from source

```sh
dsh plugin --profile <profile> add "dsh-hud@link:$PWD"
# then restart DSH
```

Remove with `dsh plugin --profile <profile> remove dsh-hud`.

## Conventions

English-only UI behind the typed `t()`; `@deepseek-ai/*` in `peerDependencies` and `devDependencies`; `engines.dsh >=0.2.2-rc.1 <0.3.0-0`; theme tokens only from `tools/dsw-defined.txt`; no polling where a push channel exists; Host routes call `connection.requestRejection(request)`.

## Licence

MIT, see [LICENSE](LICENSE). The bridge protocol, harness adapter and transcript reduction are adapted from [dsh-quorfloat](https://github.com/Azetus/dsh-quorfloat) (MIT, Copyright (c) 2026 Azetus); see [NOTICE](NOTICE).

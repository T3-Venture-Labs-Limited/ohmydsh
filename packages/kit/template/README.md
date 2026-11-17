# __PKG__

__TITLE__: a DSH plugin generated from `dsh-kit/template`.

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

`pnpm run build` emits `lib/index.js` (Host) and `lib/client.js` (+ lazy chunks `lib/client.*.js`) and then runs `scripts/check-artifacts.mjs`, which fails unless every file declared in `package.json` (`exports`, `dsh.client`, `dsh.bundle.patch`, locale, icon, detail document) exists. A missing client bundle can stop DSH from starting, so never link a plugin into a profile before the build passes.

## Install

```sh
dsh plugin --profile <profile> add "__PKG__@link:$PWD"
# then restart DSH
```

Remove with `dsh plugin --profile <profile> remove __PKG__`.

## Conventions

English-only UI behind the typed `t()`; `@deepseek-ai/*` in `peerDependencies` and `devDependencies`; `engines.dsh >=0.2.2-rc.1 <0.3.0-0`; theme tokens only from `tools/dsw-defined.txt`; no polling where a push channel exists; Host routes call `connection.requestRejection(request)`.

# dsh-theme

Follow Omarchy for DeepSeek Harness: DSH takes its colours from your Omarchy theme and updates live when you switch it, plus a handful of bundled palettes. Everything is one reversible token layer; disabling the plugin restores the stock look.

- **Host** (`src/host`): watches `~/.local/state/omarchy/current` (the parent of `theme/`, because `omarchy-theme-set` replaces `theme/` with `rm -rf` + `mv`), keyed on `theme.generation` (written after the swap), debounced 120 ms. Serves `GET /api/dsh-theme/omarchy` (through `connection.requestRejection`, fail closed: 503 when it is unavailable) and pushes changes as a Typert stream `dshTheme/omarchy` on DSH's one multiplexed Remote WebSocket (admitted at the upgrade). The page opens it only while visible and re-reads the snapshot when it returns; if the gateway is unavailable it re-reads the snapshot every 15 s. No HTTP stream: the browser allows 6 connections per host on HTTP/1.1.
- **Client** (`src/client`): `ctx.theme.overrideTokens('dsh-theme', …)` with ~45 `--dsw-alias-*` / `--dsw-specific-*` / `--shiki-token-*` names (`src/shared/tokens.ts`), and two registered empty shell themes `omarchy-dark` / `omarchy-light` selected with `setTheme` so the base palette flips with Omarchy's mode. Custom theme ids are never persisted by DSH, so the user's light/dark/system preference is untouched. One `ctx.effect` disposer removes the layer, the shell themes, the stream and restores the preference.
- **Mapping**: dark themes lift layers from `lighter_background`/`selection`, light themes from foreground tints (`lighter_background` is darker than `background` in light palettes). Text colours go through a WCAG contrast guard. Status colours keep DSH's unless the "Use Omarchy status colours" switch is on (matte-black ships yellow=red, green=amber). `button-primary-fill` takes the accent; `brand-primary` stays DSH's.
- **Pause**: a trusted user click on Appearance while following hands the look back and shows "Following paused". Our own writes are fenced so they never count as user input.
- **Palettes** (`src/artwork/palettes.ts`): about 20 colours each, expanded by the same generator.

## Develop

```sh
pnpm install
pnpm run check      # typecheck, oxlint + token lint, vitest, tsdown build, artifact check
dsh plugin --profile <profile> add "dsh-theme@link:$PWD"
# then restart DSH
```

Settings choice is stored in `localStorage` (`dsh-theme.choice`, `dsh-theme.semantic`), per browser.

## Licence

MIT, see [LICENSE](LICENSE). UI controls in `src/kit/` are adapted from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek); see [NOTICE](NOTICE). Palette data and the registry idea derive from [dsh-codex-ui](https://github.com/MichengAI/dsh-codex-ui) (Apache-2.0); see [NOTICE](NOTICE).

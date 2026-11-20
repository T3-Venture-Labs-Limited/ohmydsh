# @t3labs/ohmydsh-theme

Follow Omarchy for DeepSeek Harness: DSH takes its colours from your Omarchy theme and updates live when you switch it, plus a handful of bundled palettes. Everything is one reversible token layer; disabling the plugin restores the stock look.

- **Host** (`src/host`): watches `~/.local/state/omarchy/current` (the parent of `theme/`, because `omarchy-theme-set` replaces `theme/` with `rm -rf` + `mv`), keyed on `theme.generation` (written after the swap), debounced 120 ms. Serves `GET /api/dsh-theme/omarchy` (through `connection.requestRejection`, fail closed: 503 when it is unavailable) and pushes changes as a Typert stream `dshTheme/omarchy` on DSH's one multiplexed Remote WebSocket (admitted at the upgrade). The page opens it only while visible and re-reads the snapshot when it returns; if the gateway is unavailable it re-reads the snapshot every 15 s. No HTTP stream: the browser allows 6 connections per host on HTTP/1.1.
- **Client** (`src/client`): `ctx.theme.overrideTokens('dsh-theme', …)` with ~45 `--dsw-alias-*` / `--dsw-specific-*` / `--shiki-token-*` names (`src/shared/tokens.ts`), with the palette in both the light and the dark slot, so the colours are right whatever the Appearance setting resolves to. The plugin never calls `setTheme`: Appearance (Light/Dark/System) stays entirely the user's, and each browser keeps following its own device's light/dark mode. One `ctx.effect` disposer removes the layer and the stream.
- **Mapping**: dark themes lift layers from `lighter_background`/`selection`, light themes from foreground tints (`lighter_background` is darker than `background` in light palettes). Text colours go through a WCAG contrast guard. Status colours keep DSH's unless the "Use Omarchy status colours" switch is on (matte-black ships yellow=red, green=amber). `button-primary-fill` takes the accent; `brand-primary` stays DSH's.
- **This computer only**: Omarchy lives on the machine that runs it, so *Follow Omarchy* is the default only when the page is served from a loopback address (`127.0.0.1`, `::1`, `localhost`). Any other host (a phone over Tailscale, a LAN name) defaults to Stock, which follows that device's light/dark mode. A choice saved in that browser always wins.
- **Appearance hint**: Omarchy sets the desktop colour scheme too, so Appearance *System* normally matches. If the rendered scheme disagrees with the palette's mode, Settings → Theme says so; the plugin never changes Appearance itself.
- **Endfield look**: Settings → Theme → Look, or `look: endfield` in the profile's `dsh-theme` row for every device. A lighter rebuild of the visible parts of [dsh-theme-endfield](https://github.com/ymh0000123/dsh-theme-endfield) (MIT): square corners, solid accent buttons and rows, the ENDFIELD wordmark behind the home headline, and a glass composer, in your Omarchy or palette colours (Endfield's own yellow when colours are Stock). About 10 KB of CSS with cheap selectors and no per-frame work, against ~166 KB for the original; typing while a reply streams stays as fast as with no theme. Not included: smooth output scrolling, the boot loader, big-text and balance extras, and the full-width approval band. Uninstall dsh-theme-endfield to use it (while it is installed it draws its own look).
- **dsh-theme-endfield compatibility**: [dsh-theme-endfield](https://github.com/ymh0000123/dsh-theme-endfield) (MIT) gives DSH square corners but also registers its own token layer and body-scoped `--edge-*` accent variables, which would out-rank the Omarchy colours. When its stylesheet (`style[data-plugin="dsh-theme-endfield"]`) is on the page and dsh-theme is following Omarchy or a palette, the layer also carries endfield's variables/tokens mapped to the palette (`src/shared/endfield.ts`: `--edge-accent`, `-rgb`, `-deep`, `-onpaper`, status, plus the `--dsw-static-*`/alias tokens it re-declares), is re-registered on top whenever endfield re-registers (rate-limited, no loops), and a small bridge stylesheet (`src/client/endfield-dom.ts`, built from endfield's own rules) points its hard-coded ink-on-accent text at a readable colour. Corners and geometry are never touched, so the square look stays; turning endfield off or uninstalling it returns dsh-theme to the plain layer. Settings → Theme shows a note while it is active. Nothing runs without endfield.
- **Palettes** (`src/artwork/palettes.ts`): about 20 colours each, expanded by the same generator.

## Develop

```sh
pnpm install
pnpm run check      # typecheck, oxlint + token lint, vitest, tsdown build, artifact check
dsh plugin --profile <profile> add "@t3labs/ohmydsh-theme@link:$PWD"
# then restart DSH
```

Settings choice is stored in `localStorage` (`dsh-theme.choice`, `dsh-theme.semantic`), per browser. Tip: `dsh --trusted-host devbox.test` plus a host-resolver rule is enough to test the non-loopback default against a local server.

## Licence

MIT, see [LICENSE](LICENSE). UI controls in `src/kit/` are adapted from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek); see [NOTICE](NOTICE). Palette data and the registry idea derive from [dsh-codex-ui](https://github.com/MichengAI/dsh-codex-ui) (Apache-2.0); see [NOTICE](NOTICE).

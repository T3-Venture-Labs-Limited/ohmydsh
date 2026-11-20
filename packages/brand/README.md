# @t3labs/ohmydsh-brand

Shows **ohmydsh** instead of the DeepSeek Harness logo and name, and keeps a clear, truthful "Built on DeepSeek Harness" credit. On by default in the ohmydsh core set; everything uses DSH's public extension points, nothing on disk is patched.

| Surface | How | Changed |
|---|---|---|
| Sidebar mark (expanded and collapsed rail) | slot `sidebar.brand.mark` (priority -1, so it shadows the official artwork cleanly in either activation order) | yes |
| Sidebar name ("deepseek" + HARNESS badge) | slot `sidebar.brand.name`, same priority: the whole text block is the slot's, so the wordmark replaces it with no CSS | yes |
| New-session hero mark | slot `conversation.hero.brand.mark` | yes |
| Hero headline ("Into the Unknown" + "Preview") | DeepSeek's own wording, not brand text | left |
| Browser tab title | host `tapIndex` rewrites the stock `<title>`; the client keeps the shell's `<session> — <product>` title branded with one guarded `MutationObserver` on `<title>` | yes |
| Favicon (light/dark), apple-touch-icon, PWA icons | exact host routes at the stock paths (`/favicon.svg`, `/favicon-dark.svg`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`) with a cache-busting query on the links | yes |
| Boot splash ("HARNESS") | host index script row that swaps the text of the kernel's splash once (structure-based, with a guard test) | yes |
| Settings > General credit | slot `settings.general.item`: "ohmydsh · Built on DeepSeek Harness" (links to DeepSeek's page) and a not-endorsed note | added |
| `index.html` `apple-mobile-web-app-title` | `tapIndex` | yes |

See `docs/DETAIL.md` for the user-facing description and the list of things that cannot change.

## Config

```yaml
- id: ohmydsh-brand
  name: '@t3labs/ohmydsh-brand'
  config:
    enabled: true          # false restores the stock look
    showAttribution: true  # "Built on DeepSeek Harness" in Settings and the sidebar name tooltip
```

## How the sidebar wordmark is replaced

`dsh-client-ui-sidebar` renders the brand row as `[mark slot][name slot]` and its fallbacks are the generic "DSH Local Build" text. In a stock (`DSH_CLIENT_BUILD_PROFILE=official`) build, `dsh-client-ui-brand-official` fills both slots with DeepSeek's fish mark and the "deepseek HARNESS" wordmark at priority 0. Slots are *single*: the lowest priority renders. This plugin registers at priority -1, so its occupants render and the official ones stay mounted-but-shadowed; disabling this plugin restores them. No CSS selectors are involved.

The only two stock surfaces with no slot are the tab `<title>`/icon links (served by the Host in `index.html`) and the kernel boot splash. The splash swap is structural (`[data-dsh-boot]` descendant whose whole text is `HARNESS`) and `tests/selector-guard.spec.ts` checks that structure against the installed DSH (when `DSH_GUARD_FRONTEND` or an installed `@deepseek-ai/dsh-web-frontend` is found), so an update that moves it fails loudly.

## Develop

```sh
pnpm install
pnpm run check      # typecheck, oxlint + token lint, vitest, tsdown build, artifact check
```

Brand art lives in the repository's `assets/`; `assets/mark.svg` and `assets/wordmark.svg` are copied into this package and compiled into `src/artwork/paths.ts` by `node scripts/gen-artwork.mjs` (checked by `pnpm run check`).

## Licence

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). ohmydsh is unofficial: DeepSeek did not make it and does not endorse it.

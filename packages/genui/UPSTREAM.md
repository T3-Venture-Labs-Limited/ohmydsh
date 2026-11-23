# Upstream

This package is a modified build of [dsh-genui](https://github.com/omdsh-dev/dsh-genui) (MIT, by changfenhuang and the
omdsh-dev contributors), published upstream as `@changfenhuang/dsh-genui`. It is **not** our work apart from the changes
below. ohmydsh normally installs community plugins from npm unmodified; GenUI is the one deliberate exception (see
`docs/DESIGN.md`, "Own packages and forks").

| | |
|---|---|
| Upstream | https://github.com/omdsh-dev/dsh-genui |
| Upstream base | `v0.17.0`, commit `a5c4232` ("release: prepare GenUI 0.17.0") |
| Our branch | https://github.com/deestax/dsh-genui/tree/feat/social-post-previews, head `fa94bca` (pushed; review fixes for omdsh-dev/dsh-genui#470) |
| Upstream PR | omdsh-dev/dsh-genui#470 (social post previews), open |
| Version here | `0.17.2` = upstream 0.17.0 + the three commits below. |

## Changes against upstream 0.17.0

1. `ae66d4c` feat: `x-post` and `linkedin-post` social post previews.
   - `x-post`: an X post or a thread, one card per post joined by the thread line, an X-weighted character counter per
     post (a URL counts 23, CJK and emoji count 2), amber in the last 20, red and negative past 280 (or a custom limit).
   - `linkedin-post`: a LinkedIn feed post folded at "…see more" (about 210 characters on desktop, 140 on mobile, or
     three lines; blank lines spend a line), expands locally, shows the visible character count, desktop/mobile switch.
   - New `src/client/blocks/social-post.tsx`, `social-post.module.css`, `src/client/social-text.ts`; schema, guard,
     limits, i18n, dsh-go compiler and SKILL.md entries; tests in `tests/genui-social-post.spec.tsx`.
2. `9d9114f` fix(x-post): count with the official `twitter-text` parser; label the LinkedIn fold as an estimate
   (review on #470: 278 characters + `1️⃣` reported 283 instead of 280).
   - X counting and URL detection use `twitter-text` 3.1.0 (`parseTweet`, default v3 config, emoji parsing on;
     `extractUrlsWithIndices` for highlighting and the t.co display). Renderer, standalone export and the dsh-go
     projection share one `xCharStatus`. The counter shows `weightedLength/limit`, fills by `permillage` and exposes
     `valid`.
   - `twitter-text` (Apache-2.0) is bundled into `lib/index.js`, `lib/client.js` and the standalone runtime with its
     core-js 2 polyfill imports resolved to an empty module (`tsdown.config.ts`); notices in `THIRD_PARTY_NOTICES.md`.
   - The LinkedIn fold note, the native projection and SKILL.md say the fold is an estimate.
3. `fa94bca` fix(x-post): ship twitter-text bundled only; surface posts X would reject; document the emoji-data limit.
   - `twitter-text` is a dev dependency only (bundled; nothing imports it at runtime), so installing the package no
     longer pulls core-js 2.
   - Posts X would reject inside the limit (U+FFFE, U+FEFF, bidi overrides) turn red with "X would reject this post"
     and count in the thread footer; an empty post stays neutral.
   - Emoji detection follows twitter-text 3.1.0's emoji data: some newer emoji count more (`❤️‍🔥` = 5).

## Differences in packaging (no behaviour change)

- Published as `@t3labs/ohmydsh-genui`. The browser module id, the boot-graph lookup for the asset rev and the asset
  route (`/plugins/@t3labs/ohmydsh-genui/assets`) use the new package name, because the host resolves all three from
  the package name.
- Kept on purpose: the `genui` row id and the cordis `name` export (`@changfenhuang/dsh-genui`), so existing settings
  and the fence-feedback source kind recorded in older Sessions keep matching. Do not rename the row.
- Dev dependencies follow the repo's DSH pin (`0.2.2-rc.5`, cordis `4.1.0`, cordis-plugin-loader `1.1.0`); peer ranges
  and `engines.dsh` use the repo convention `>=0.2.2-rc.1 <0.3.0-0` (`tests/peer-range.spec.ts` asserts that range;
  older hosts are not supported by ohmydsh). Added dev dependencies: `@deepseek-ai/dsh-tool-executor-native` (the real
  AgentLoop test needs it on rc.5) and `@deepseek-ai/dsh-web` with a `paths` entry in `tsconfig.json`:
  `dsh-api-remotes` imports `@deepseek-ai/dsh-web` types without declaring it, and in this workspace the hoisted copy is
  another package's older dev pin, whose `dsh-llm` types clash. Type-check only; no runtime change.
- Not included: upstream's product site (`site/`), GitHub workflows, `AGENTS.md`, its lockfile and workspace file, and
  the one-line npm installer (`scripts/install.sh` and its test); ohmydsh installs the plugin through `omd`. The two
  tests that asserted upstream's own CI workflow files were removed. Upstream's e2e and acceptance scripts are kept
  (some tests import them) with the package name updated; they are not part of `check`.
- Added: `NOTICE`, this file, a `lint:tokens` step in `check` (see below).
- Token lint: GenUI themes itself through host `--dsw-*` tokens with literal fallback colours (charts, diagrams, maps,
  brand glyphs, the standalone export). Rewriting those would diverge from upstream for no gain, so `lint:tokens` only
  checks that every `--dsw-*` name it reads exists; literal colours are allowed (`--tokens-only`).

## Updating

Rebase our branch on a newer upstream tag, run its tests, then copy `src/`, `tests/`, `scripts/` and the top-level
docs here again, re-apply the packaging differences above and bump the version. Drop a change here once upstream
merges and releases it; when upstream has everything, ohmydsh can go back to installing `@changfenhuang/dsh-genui`.

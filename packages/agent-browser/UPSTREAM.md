# Upstream

This package is a modified build of [dsh-agent-browser](https://github.com/shantanugoel/dsh-agent-browser)
(MIT, by the dsh-agent-browser contributors). It is **not** our work apart from the changes below.

| | |
|---|---|
| Upstream | https://github.com/shantanugoel/dsh-agent-browser |
| Upstream base | `v0.2.7`, commit `4142146c2b925d257bcd093babac82f9eeb9bfa5` |
| Our branch | https://github.com/deestax/dsh-agent-browser/tree/feat/movable-chip, head `6461c775f4d01ea6f44595ee9f5d561096859727` |
| Upstream PRs | #1 (idle back-off), #3 (small draggable chip, includes the back-off commit) |
| Version here | `0.2.8` = upstream 0.2.7 + the two commits below. (The manifest check requires the workspace version to equal its pin, so this is not `0.2.7-ohmydsh.1`.) |

## Changes against upstream 0.2.7

1. `4eced7833946712685bfd2dbcd1a670987291a68` perf: the panel polls its session list only while the page is visible and backs off (2.5 s up to 10 s) while nothing changes. New `client/visible-interval.ts` + tests.
2. `6461c775f4d01ea6f44595ee9f5d561096859727` The collapsed "Browser (N)" chip is a small draggable round button, position stored per window size and clamped; the panel opens next to it. New `client/chip-position.ts` + tests (it sat on the phone composer's send button).

## Differences in packaging (no behaviour change)

- Published as `@t3labs/ohmydsh-agent-browser`; the client module id is the new package name; the client bundle is `lib/client.js` (upstream: `client/dist/client.js`).
- `dsh-agent-browser-core` 0.1.5 is a normal npm dependency (upstream: workspace package). Its runtime dependency `agent-browser` stays at 0.43.0.
- The `browser` row id and its config keys are unchanged, so existing settings carry over. Do not rename the row.
- Added: `docs/DETAIL.md`, `locale/en.json`, `icon.svg`, `scripts/check-artifacts.mjs`, a `check` script. The mock agent-browser CLI used by the tests is copied from the core package's test fixtures. Upstream's live/debug scripts are not included.
- The token lint is not applied: the client keeps upstream's own inline styles (literal colours); rewriting it would diverge from upstream for no gain.

## Updating

Rebase our branch on a newer upstream tag, run its tests, then copy `client/`, `src/` and `test/` here again and bump the version.
Drop a change here once upstream merges it.

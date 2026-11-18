# @t3labs/ohmydsh-skill-studio

Skills manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.2.2: see, edit, create and disable every agent skill, in DSH only.

| | |
|---|---|
| Page | sidebar entry **Skills** (panel id `skills`) |
| Disable | DSH-only list in `$DSH_HOME/skill-studio/settings.json` (default `~/.dsh/skill-studio/`); skill files are never modified |
| Edit | validated like the DSH loader; backup to `$DSH_HOME/skill-studio/backups/<skill>/` before each save; optimistic lock; atomic write |
| Create | `~/.agents/skills/<name>/SKILL.md` (default), `~/.dsh/skills`, or the project's `.agents/skills` / `.dsh/skills` |
| Compatibility | `engines.dsh >=0.2.2-rc.1 <0.3.0-0`; the registry patch fails open outside that range or if the registry shape changes |

## How disabling works

The host half wraps the live `SkillRegistry`'s `list`, `snapshot` and `get` and filters by the disabled set, so the model catalog, the
`skill` tool, `/name` injection and the `/` menu all agree. See [docs/upstream-skills-restrict.md](docs/upstream-skills-restrict.md)
for the upstream hook that would replace this patch.

## Layout

```
src/index.ts            host entry: registry filter + API routes (/api/skill-studio/*)
src/host/               frontmatter validator, scanner, settings store, writer (the only code that writes skill files), usage index
src/client/             page, detail editor, create dialog (lazy chunk) + sidebar icon
src/kit/                source copy of dsh-kit/ui
```

Settings, backups and (later) proposals live under `$DSH_HOME/skill-studio/`, never inside a skill root.

## Develop

```sh
pnpm install
pnpm run check      # typecheck + token lint + tests + build + artifact check
dsh plugin --profile <profile> add "@t3labs/ohmydsh-skill-studio@link:$PWD"   # only after a green build
# then restart DSH
```

## Evolution (propose_skill, proposal queue, reviewer)

- `propose_skill` (model tool): validates (same rules as the DSH loader, secret scan, size, duplicates/overlap with existing skills, per-session and global caps, rejection ledger) and **queues**. It has no write path to any skill root.
- Approval is a separate route used by the page/card: re-validates, checks the base hash for improvements, writes through `writer.ts` (backup first). New skills go to `~/.agents/skills` by default; under a non-default `DSH_HOME` (the dev harness) they go to `$DSH_HOME/skills` so development never touches real skills.
- Reviewer (`src/host/reviewer.ts`): idle debounce on `turn/end` + hourly check for a daily sweep + manual "Review now" (optionally scoped to a folder). Transcripts are condensed in `src/host/transcript.ts`: redacted, **tool calls only, never tool results**, capped. Two LLM stages (candidates, then draft); merge across sessions; budgets; run log with the reviewed session ids.
- Model: `automationModels.resolve('skill-reviewer')` when the dsh-automation-models service exists (the source is registered with a Sonnet/low default), else `claude/claude-sonnet-5-5` low from the plugin's own config.
- State: `$DSH_HOME/skill-studio/{settings,config,proposals,review}.json`. Push channel for the badge and cards: Typert stream `dshSkillStudio/summary` on DSH's multiplexed WebSocket, open only while a badge/card/page is mounted and the page is visible (no HTTP stream; a 15 s poll of the proposals route covers a missing gateway).

## Licence

MIT, see [LICENSE](LICENSE). UI controls in `src/kit/` are adapted from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek); see [NOTICE](NOTICE).

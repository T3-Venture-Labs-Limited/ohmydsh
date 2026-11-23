# ohmydsh design

Status: plan, agreed 2026-11-17. Milestone 1 is built: monorepo skeleton, imported packages, `ohmydsh.json`, the `omd` CLI, installer script and CI. Milestone 2 is built: the packages are renamed to the `@t3labs` scope, `ohmydsh.json` installs them from npm and a tag-driven release workflow publishes them. Waiting on: the first `v0.1.0` tag and the `NPM_TOKEN` secret.

## Goals

1. **One-line install** of a working DeepSeek Harness with our full plugin set.
2. **Safe, boring updates:** one command, tested as a set, with rollback.
3. **Low maintenance** for the people who build the plugins.
4. **Never surprise the user:** no changes outside our own profile, never overwrite their own settings.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where do our plugins live? | **One monorepo** (`packages/*`), history imported from the existing `deestax/dsh-*` repos, which are then archived with a pointer here. | Shared kit becomes a real package instead of copied code; one CI, one release; cross-plugin changes are one pull request. |
| Submodules? | **No.** | Every change would need two commits in two repos, detached-HEAD mistakes are easy, and users don't need source checkouts at all. |
| Community plugins? | **Pinned from npm, never vendored or forked.** Fixes go upstream as PRs. One deliberate exception: GenUI (see below). | They keep their authors and licences; we don't inherit their maintenance. |
| How do users get our plugins? | **npm under the `@t3labs` organisation** (e.g. `@t3labs/ohmydsh-studio`). | DSH's plugin manager can then check versions and update them itself; registry installs avoid build scripts. A `--manifest` pointing at packed tarballs stays as an escape hatch (CI uses it). |
| Where does it install? | **Its own DSH profile, `omd`.** | Never touches the user's `web` profile; can be made the default later with one command. |
| What's on by default? | **Core set on; account- or desktop-specific plugins as opt-in packs.** | A new user gets something that works without any accounts beyond a model. |
| npm name for the CLI | **`@t3labs/ohmydsh`** (binary `omd`). | `oh-my-dsh` on npm already belongs to a different project (amplifthq/oh-my-dsh); we avoid that name to prevent confusion. |

## The manifest: `ohmydsh.json`

The single source of truth. A release of ohmydsh is a new version of this file.

```jsonc
{
  "version": "0.1.0",
  "dsh": "0.2.2-rc.5",                // exact DSH version this set was tested with
  "node": ">=24",
  "plugins": {
    "core": {
      "@t3labs/ohmydsh-studio": "0.1.0",
      "dsh-better-sidebar": "0.32.1",
      "dsh-plugin-subscriptions": "0.9.13"
      // … every core plugin, exact versions
    },
    "packs": {
      "composio": { "@t3labs/ohmydsh-composio": "0.1.0" },
      "langfuse": { "@t3labs/ohmydsh-langfuse": "0.1.0" },
      "parallel": { "@t3labs/ohmydsh-web-search-parallel": "0.1.0" },
      "omarchy":  { "@t3labs/ohmydsh-theme": "0.1.0", "@t3labs/ohmydsh-hud": "0.1.0" }
    }
  },
  "allowBuilds": ["agent-browser@0.43.0"],  // install scripts we have reviewed
  "patches": {                              // temporary fixes for one exact community version, see below
    "@kenz1117/dsh-engram@0.13.15": { "file": "profile/patches/dsh-engram@0.13.15.patch", "note": "…", "issue": "https://github.com/…/issues/64" }
  }
}
```

### Patched community packages

A community plugin we pin sometimes has a bug we cannot wait for upstream to fix. `patches` carries a fix for **one exact `name@version`** until upstream ships its own; the entry names the upstream issue to follow, and the patch is removed again by deleting the entry (and the file) once a fixed version is pinned.

- **Making a patch:** in a scratch project run `pnpm patch name@version`, edit, `pnpm patch-commit`, and copy the generated file to `profile/patches/<name>@<version>.patch` (never hand-write it: pnpm hashes it and expects its exact format). `scripts/check-manifest.mjs` fails unless every patch key is the version pinned right now, has an `issue` URL and a `note`, and its file exists and is a git diff.
- **Installing it:** `omd setup`/`omd update` copy each patch that applies into `<profile>/patches/ohmydsh/` (the folder is rebuilt every time, so a dropped patch disappears) and write pnpm's `patchedDependencies` into the managed block of the profile's `pnpm-workspace.yaml`. pnpm fails the whole install with `ERR_PNPM_UNUSED_PATCH` for a patch it does not use, so omd writes only patches whose `name@version` is in the set being installed at exactly that version from the registry or a tarball: never for another pinned version, a pack that is off, or a `--dev` link. A `patchedDependencies` the user wrote outside the block wins (omd warns and applies nothing). The lock records `patches`; `omd list` prints `patched: <name>@<version>, <note>, see <issue>`; `omd doctor` checks the file, the installed version and that pnpm's lockfile carries the `patch_hash`.
- **Following upstream:** a candidate that moves a patched package to another version is not released by the follow workflow (the patch would silently stop applying). `follow-run.mjs` does not run the gate for it; it is reported as `needs-human` with reason `patched`, and the usual `follow: <name> <version> does not pass` issue explains it. A human re-checks the upstream issue, then drops the patch or regenerates it for the new version and pins the new version by hand. `gate.mjs` refuses such a candidate too.
- **Current patches:** `@kenz1117/dsh-engram@0.13.15`: its closing-time consolidation (archive stale memories, merge near duplicates) ran at every start and re-embedded every memory on the host thread, blocking the UI for 10 to 25 s ([kenz1117/dsh-engram#64](https://github.com/kenz1117/dsh-engram/issues/64)). The patch runs the first pass 10 minutes after start instead (`OMD_ENGRAM_CONSOLIDATION_DELAY_MS` overrides the delay); the 24 h interval is unchanged, both timers are cleared when the plugin is disposed, and the first one is `unref`'d. Nothing else depends on the start-up run: the decay pass at start is separate and stays, and the panel's "consolidate" button calls the same function directly.

## The profile: three layers

```text
~/.dsh/profiles/omd/
├─ package.json            plugin dependencies (written by omd from the manifest)
├─ cordis.patch.yml        managed block "ohmydsh defaults" + the user's own rows below it
└─ ohmydsh.lock.json       what omd installed (manifest version, plugins, packs) → lets update/rollback
                           tell "ours" from "the user's"
```

- **ohmydsh defaults** live between `# >>> ohmydsh` / `# <<< ohmydsh` markers and are rewritten on every update (web providers, Studio provider, automation model, …).
- **User rows** are everything outside the markers, plus `~/.dsh/cordis.patch.yml`, which DSH applies last. `omd` never edits them.
- **User-added plugins** (not in the lock file) are left alone by update and rollback.

## The `omd` CLI (`packages/cli`)

Small Node CLI, no runtime dependencies beyond Node 24.

| Command | Behaviour |
|---|---|
| `omd setup` | Ensure Node 24 and the pinned DSH (`npm i -g @deepseek-ai/dsh@<pin>` or mise if present); create profile `omd`; install core; write defaults; `omd doctor`. Idempotent: re-running repairs. |
| `omd` | `exec dsh omd` (web UI). |
| `omd add/remove <pack>` | Add or remove a pack's plugins; record in the lock file. |
| `omd update` | Fetch the newest released manifest → install into a **staging copy** of the profile (`omd-next`) → boot it headless with `--dump-config` and a short web boot → if healthy, swap directories atomically and keep the old one as `omd-prev`. On any failure, delete staging; the live profile is untouched. |
| `omd rollback` | Swap `omd` and `omd-prev`. Reversible. |
| `omd doctor` | DSH version vs pin, every plugin present and loading, model login present, optional keys per pack, HTTPS for the phone app. Prints exactly what the user must do. |
| `omd list` | Installed set with versions; marks user-added plugins. |
| `omd default` | Optional: make `dsh` with no profile start `omd`. |

Lessons already learned in our own setup that the CLI must handle:

- A same-id patch row **replaces** a plugin's whole config. The defaults block always lists every field it sets (e.g. both `searchProvider` and `fetchProvider`).
- Unapplied patch rows (a row naming a removed plugin) only warn in DSH; `omd` treats them as errors during update, like `scripts/promote-to-web.sh` does.
- Two DSH homes must never share subscription logins (rotating refresh tokens). `omd` never copies `auth.json` or `*_OAUTH_*` credentials between profiles or homes.
- Restarting a running DSH kills shells inside it; `omd update` never restarts a running DSH by itself. It prints "restart DSH to finish", or waits for idle sessions with `--when-idle`.

## Installer: `install.sh`

POSIX sh, readable in one screen. Checks OS, finds or installs Node 24 (via mise if present, else prints the one-line instruction), runs `npm i -g @t3labs/ohmydsh@latest`, then `omd setup`. No sudo. Windows: WSL only.

## Release and maintenance

- **One tag, one release** (no changesets: with one manifest version and exact pins a release PR adds nothing): a PR that changes a plugin bumps its version and its pin; pushing `v<ohmydsh.json version>` runs `release.yml`, which checks everything, publishes the `@t3labs/*` packages that are not on npm yet (with provenance, so re-runs are safe), creates the GitHub Release from `CHANGELOG.md` and attaches the desktop and Android apps.
- **CI on every PR:** each package's `check` (typecheck, lint, token lint, tests, build), then an **integration job**: fresh `DSH_HOME`, `omd setup` from the PR's manifest, boot DSH, assert every plugin row activates (journal has no `failed to import`, `--dump-config` has no unapplied rows), check every plugin's routes answer 401 without a cookie. A second integration job packs every package and installs the set from the tarballs, so a package that only works linked fails before it is published.
- **Following upstream (`follow.yml`, daily):** ohmydsh tracks the newest `latest` of `@deepseek-ai/dsh` and of every community plugin in `ohmydsh.json` (never an alpha, never a downgrade; our own packages, the `sources`, are not followed). There are no pull requests: the organisation does not let Actions open them, and events made with `GITHUB_TOKEN` do not start other workflows except `workflow_dispatch`. So the workflow itself decides, and a green result releases:
  1. `plan`: list candidates (`scripts/follow-upstream.mjs --list`), minus packages on hold and exact versions that already have an open `follow` issue. Nothing newer, or a Release run in progress: done.
  2. `test`: the **gate** (`scripts/gate.mjs`, run through `gate.yml` on Linux and macOS) with all candidates pinned: workspace install and `pnpm -r run check` (when DSH is a candidate), manifest/private/pack audits, `omd setup` from the packed tarballs into a clean home that installs the manifest's DSH, composed config clean (no unapplied rows, every plugin contributes), web boot without load failures, every pack added and still clean, `omd setup --dev`, and `omd update` **from the previously released ohmydsh** (its published manifest and CLI) to the candidate manifest, then boot, `omd rollback` and forward again. When red: DSH alone, each plugin alone, then the passing ones together (`scripts/follow-run.mjs`).
  3. `release`: what passed on every OS is pinned (`--apply`, which also rewrites every duplicated DSH pin), the next patch version and a CHANGELOG section are written (`--release-notes`), the commit `follow: dsh A -> B, plugin X a -> b` goes to `main` as `github-actions[bot]`, the tag `vX.Y.Z` is pushed and `gh workflow run release.yml -f tag=vX.Y.Z` publishes it. If `main` moved during the run nothing is pushed and the next run starts over.
  4. Issues: each failing candidate gets ONE issue, `follow: <name> <version> does not pass` (label `follow`, failing step and log tail). A later run closes it when that version or a newer one passes. Nothing is recorded in the repository: the open issue is the memory, and an exact `name@version` with an open issue is not retested (a manual run with `only: name@version` forces it). A pnpm **ignored build script** is reported as "needs a human": omd never approves install scripts by itself.
  5. **Hold:** to keep a package where it is, open an issue titled `follow: <name> hold` with the labels `follow` and `hold`. The package is not proposed while it is open; close it to resume. Pinning back by hand (editing `ohmydsh.json`) also works, but the next run would re-propose the newer version unless there is a hold.
  `workflow_dispatch` takes `dry_run` (test and report, change nothing) and `only` (`name@version`). Runs never overlap (concurrency group) and are skipped while a Release run is active.
- **`omd update` moves DSH too:** when the new manifest pins another DSH, omd installs it into a temporary prefix, builds and checks the staged profile with that binary, and only then swaps the profile and switches the global DSH (npm or mise installs only; `--no-dsh-install` and a DSH omd did not install, such as the desktop app's runtime, are never touched). The lock file records `dsh.version` and `dsh.previous`; `omd rollback` restores both; `omd doctor` reports an installed DSH that differs from the lock. A failure at any point leaves profile and DSH as they were.
- **Upstream fixes:** keep a short list of open upstream PRs in `docs/UPSTREAM.md`; when one merges, bump that plugin in the manifest.
- **Privacy:** the existing private-strings check from `scripts/publish-github.sh` runs in CI on every commit.

## Migration of our existing plugins

1. `git subtree add`/`git filter-repo` each `deestax/dsh-*` repo into `packages/<name>` keeping history (dsh-kit, studio, pwa, review-comments, skill-studio, notebook, triggers, automation-models, composio, langfuse, theme, hud, agent-browser-takeover, web-search-parallel fork; dsh-hud-qt stays its own repo, it is a C++ desktop app).
2. Replace each plugin's copied `src/kit` with a dependency on `@t3labs/ohmydsh-kit` (private, bundled at build time, so nothing changes at runtime).
3. Rename packages to `@t3labs/ohmydsh-<name>`, keep the plugin row ids unchanged so existing user settings keep working.
4. Archive the `deestax/dsh-*` repos with a README pointer.
5. Move the maintainers' own setups onto the `omd` profile (or keep `web` linked to the monorepo for development).

## Open items

- The npm organisation `t3labs` exists; the repository secret `NPM_TOKEN` must be added before the first tag.
- Decide whether the phone-app plugin should default on (it needs HTTPS to be useful).
- Licences: Studio and Notebook are Apache-2.0 forks; their NOTICE files move with them.

## Milestone 1 status and names

Built: `packages/*` (history imported from the public deestax repos, which were already squashed), `ohmydsh.json`,
`profile/` defaults and pack rows, `packages/cli` (`omd setup | doctor | list | add | remove | update | rollback`),
`install.sh`, CI (`ci.yml`, `canary.yml` skeleton) and the private-strings audit.

Package names (renamed in milestone 2). **Plugin row ids did not change**: a row id is what users' settings are keyed by,
only the row's `name:` (the package it loads) is new.

| Folder | Was | npm name | Row id (unchanged) |
|---|---|---|---|
| `packages/cli` | `@ohmydsh/cli` | `@t3labs/ohmydsh` (binary `omd`) | n/a |
| `packages/kit` | `dsh-kit` (private) | `@t3labs/ohmydsh-kit` (stays private: plugins copy its source, no runtime dependency) | n/a |
| `packages/studio` | `dsh-studio` | `@t3labs/ohmydsh-studio` | `studio` |
| `packages/pwa` | `dsh-pwa` | `@t3labs/ohmydsh-pwa` | `dsh-pwa` |
| `packages/browser-takeover` | `dsh-agent-browser-takeover` | `@t3labs/ohmydsh-browser-takeover` | `agent-browser-takeover` |
| `packages/agent-browser` | `dsh-agent-browser` (community, modified build) | `@t3labs/ohmydsh-agent-browser` | `browser` |
| `packages/review-comments` | `dsh-review-comments` | `@t3labs/ohmydsh-review-comments` | `review-comments` |
| `packages/skill-studio` | `dsh-skill-studio` | `@t3labs/ohmydsh-skill-studio` | `skill-studio` |
| `packages/notebook` | `dsh-notebook` | `@t3labs/ohmydsh-notebook` | `dsh-notebook` |
| `packages/triggers` | `dsh-triggers` | `@t3labs/ohmydsh-triggers` | `dsh-triggers` |
| `packages/automation-models` | `dsh-automation-models` | `@t3labs/ohmydsh-automation-models` | `dsh-automation-models` |
| `packages/composio` | `dsh-composio` | `@t3labs/ohmydsh-composio` | `dsh-composio` |
| `packages/langfuse` | `dsh-langfuse` | `@t3labs/ohmydsh-langfuse` | `dsh-langfuse` |
| `packages/theme` | `dsh-theme` | `@t3labs/ohmydsh-theme` | `dsh-theme` |
| `packages/hud` | `dsh-hud` | `@t3labs/ohmydsh-hud` | `dsh-hud` |
| `packages/web-search-parallel` | `@parallel-web/dsh-web-search-parallel` | `@t3labs/ohmydsh-web-search-parallel` (our fork; keeps Parallel's LICENSE, adds a NOTICE) | `web-search-parallel` |
| `packages/genui` | `@changfenhuang/dsh-genui` (community, modified build) | `@t3labs/ohmydsh-genui` (keeps upstream's LICENSE and THIRD_PARTY_NOTICES, adds a NOTICE and UPSTREAM.md) | `genui` |

Hard-coded HTTP paths are API paths, not package names, and did not change: `/plugins/dsh-studio/...` (Studio) and
`/dsh-notebook/...` (Notebook). Everything DSH derives from the package name (the client bundle id and the
`/plugins/<package>/client.js` URL, the remote-stream package id, the settings slot key) was changed together with the
package.

### The GenUI exception

GenUI (`packages/genui`, `@t3labs/ohmydsh-genui`) is the one community plugin that ohmydsh carries as its own
implementation instead of pinning it from npm. This was a deliberate owner decision (November 2026), overriding the
"never forked" rule above for this plugin only: GenUI is the surface the agent uses for every structured answer, we
want features on our own schedule (the `x-post` and `linkedin-post` social post previews first), and a pnpm patch of
its minified bundles was too large to review. The rules for it:

- It is a modified copy of `@changfenhuang/dsh-genui` (MIT, by changfenhuang and the omdsh-dev contributors). Upstream's
  `LICENSE` and `THIRD_PARTY_NOTICES.md` stay in the package; its `NOTICE` credits them and `UPSTREAM.md` lists the base
  commit, every change and every packaging difference.
- The `genui` row id and the plugin's cordis `name` export (`@changfenhuang/dsh-genui`) are unchanged, so existing
  settings keep working. Things DSH derives from the package name (the client module id, the boot-graph entry, the
  `/plugins/<package>/assets` route) use `@t3labs/ohmydsh-genui`.
- Changes still go upstream as pull requests ([`docs/UPSTREAM.md`](UPSTREAM.md)). When upstream catches up we rebase on
  its newer tag; if upstream ever contains everything we need, ohmydsh can go back to pinning the npm package.
- The follow workflow does not track it (it is a `sources` entry like our other packages).

### Decisions made while building

- The manifest has `sources` (per plugin: the workspace folder for `--dev`, and an optional `tarball` escape hatch), `packInfo` (summary, requirements,
  optional rows file) and `profile` (profile name, defaults file, official optional bundles to switch on).
- Both managed blocks (`cordis.patch.yml` and `pnpm-workspace.yaml`) are rewritten between the markers; rows outside them
  are never touched, and the managed block sits first so the user's rows win.
- `omd update` stages `omd-next`, runs `dsh plugin install`, then `dsh --dump-config`. A patch row that names a plugin
  that is not active (dsh only warns) is an error, as is any pinned plugin that did not contribute to the config.
  Only then are the folders swapped; `omd-prev` is kept and `omd rollback` swaps them back (and again to undo).
- A running DSH on the profile blocks the swap unless `--force`; omd never restarts DSH.
- An optional `--boot-check` boots the staged web app briefly and looks for load failures.
- Gotcha for any test home: some plugins read `~/.dsh` directly (dsh-engram "adopts" an existing store into a second
  `DSH_HOME`). Boot test homes with a fake `HOME` (see `scripts/dev-env.sh`, `OMD_FAKE_HOME=1`).

# ohmydsh design

Status: plan, agreed 2026-11-17. Nothing below is built yet except the artwork and the README.

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
| Community plugins? | **Pinned from npm, never vendored or forked.** Fixes go upstream as PRs. | They keep their authors and licences; we don't inherit their maintenance. |
| How do users get our plugins? | **npm under the `@ohmydsh` scope** (e.g. `@ohmydsh/studio`). | DSH's plugin manager can then check versions and update them itself; registry installs avoid build scripts. GitHub release tarballs stay as a fallback. |
| Where does it install? | **Its own DSH profile, `omd`.** | Never touches the user's `web` profile; can be made the default later with one command. |
| What's on by default? | **Core set on; account- or desktop-specific plugins as opt-in packs.** | A new user gets something that works without any accounts beyond a model. |
| npm name for the CLI | **`@ohmydsh/cli`** (binary `omd`). | `oh-my-dsh` on npm already belongs to a different project (amplifthq/oh-my-dsh); we avoid that name to prevent confusion. |

## The manifest: `ohmydsh.json`

The single source of truth. A release of ohmydsh is a new version of this file.

```jsonc
{
  "version": "0.1.0",
  "dsh": "0.2.2-rc.3",                // exact DSH version this set was tested with
  "node": ">=24",
  "plugins": {
    "core": {
      "@ohmydsh/studio": "0.1.0",
      "dsh-better-sidebar": "0.32.1",
      "dsh-plugin-subscriptions": "0.9.13"
      // … every core plugin, exact versions
    },
    "packs": {
      "composio": { "@ohmydsh/composio": "0.1.0" },
      "langfuse": { "@ohmydsh/langfuse": "0.1.0" },
      "parallel": { "@ohmydsh/web-search-parallel": "0.1.0" },
      "omarchy":  { "@ohmydsh/theme": "0.1.0", "@ohmydsh/hud": "0.1.0" }
    }
  },
  "allowBuilds": ["agent-browser@0.43.0"]  // install scripts we have reviewed
}
```

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

POSIX sh, readable in one screen. Checks OS, finds or installs Node 24 (via mise if present, else prints the one-line instruction), runs `npm i -g @ohmydsh/cli@latest`, then `omd setup`. No sudo. Windows: WSL only.

## Release and maintenance

- **Changesets** for versioning: each PR that changes a plugin adds a changeset; merging the release PR bumps versions, publishes changed `@ohmydsh/*` packages to npm and cuts a new `ohmydsh.json`.
- **CI on every PR:** each package's `check` (typecheck, lint, token lint, tests, build), then an **integration job**: fresh `DSH_HOME`, `omd setup` from the PR's manifest, boot DSH, assert every plugin row activates (journal has no `failed to import`, `--dump-config` has no unapplied rows), check every plugin's routes answer 401 without a cookie.
- **Weekly canary:** try the newest versions of community plugins and the next DSH release in CI; open a PR bumping `ohmydsh.json` when green, an issue when red.
- **Upstream fixes:** keep a short list of open upstream PRs in `docs/UPSTREAM.md`; when one merges, bump that plugin in the manifest.
- **Privacy:** the existing private-strings check from `scripts/publish-github.sh` runs in CI on every commit.

## Migration of our existing plugins

1. `git subtree add`/`git filter-repo` each `deestax/dsh-*` repo into `packages/<name>` keeping history (dsh-kit, studio, pwa, review-comments, skill-studio, notebook, triggers, automation-models, composio, langfuse, theme, hud, agent-browser-takeover, web-search-parallel fork; dsh-hud-qt stays its own repo, it is a C++ desktop app).
2. Replace each plugin's copied `src/kit` with a dependency on `@ohmydsh/kit` (bundled at build time, so nothing changes at runtime).
3. Rename packages to `@ohmydsh/<name>`, keep the plugin row ids unchanged so existing user settings keep working.
4. Archive the `deestax/dsh-*` repos with a README pointer.
5. Switch Daryll's own `web` profile to the `omd` profile (or keep `web` linked to the monorepo for development).

## Open items

- An npm organisation `ohmydsh` must be created and owned by T3 Venture Labs (needs a human with an npm account).
- Decide whether the phone-app plugin should default on (it needs HTTPS to be useful).
- Licences: Studio and Notebook are Apache-2.0 forks; their NOTICE files move with them.

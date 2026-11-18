# Contributing to ohmydsh

Thanks for helping. This is a monorepo: the `omd` CLI, our plugins and the manifest that ties them to one tested
DeepSeek Harness release live together, so a change to one plugin is tested with all the others.

## Setup

You need Node 24 and pnpm 12 (`corepack enable` or `npm i -g pnpm`).

```sh
pnpm install            # builds every package once (each plugin's `prepare` script)
pnpm run check          # every package's typecheck, lint, tests and build
pnpm run check:private  # the private-strings audit CI also runs
pnpm run check:manifest # ohmydsh.json matches packages/* (versions equal their pins)
pnpm run pack:all       # pack every public package, audit the tarballs, write .tmp/tarballs/ohmydsh.json
```

If your environment can't write to the usual pnpm/npm folders, `source scripts/dev-env.sh` first: it points the
stores, caches and temp dirs inside `.tmp/` (git-ignored).

## Layout

```text
packages/<name>/     one plugin (or the CLI) per folder, each with its own package.json and `check` script
profile/             default patch rows for the omd profile (defaults.cordis.yml, packs/*.cordis.yml)
ohmydsh.json         the manifest: DSH version + exact version of every plugin and pack
scripts/             repo tooling (private-strings audit, manifest check, dev-env)
CHANGELOG.md         release notes (the section of the tagged version becomes the GitHub Release)
```

## Working on a plugin

```sh
cd packages/studio
pnpm run check          # typecheck + lint + tests + build, same as CI
```

Try it in a real DSH without touching your own profile. Use a throwaway home:

```sh
export DSH_HOME=$PWD/.tmp/omd-home
node packages/cli/bin/omd.js setup --dev      # links packages/* into profile "omd"
dsh omd                                        # boot it; do not point this at your daily DSH home
```

Never copy login files (`auth.json`, `*_OAUTH_*`) into a second DSH home: refresh tokens rotate and sharing them logs
the first home out.

## Rules that keep the set healthy

- English UI strings behind the plugin's `t()`; theme tokens only, no literal colours (the token lint enforces it).
- `@deepseek-ai/*` packages go in both `peerDependencies` (range `>=0.2.2-rc.1 <0.3.0-0`) and `devDependencies`.
- Host routes call `connection.requestRejection(request)`, fail closed and check same-origin on mutations.
- Heavy client code loads through dynamic `import()`. No polling where a push channel exists.
- Don't rename a plugin's patch-row id: people's settings are keyed by it.
- Community plugins are never vendored or forked here. Send the fix upstream and list the PR in `docs/UPSTREAM.md`.

## Versions and releases

Our plugins are published to npm as `@t3labs/ohmydsh-<name>` and the CLI as `@t3labs/ohmydsh`. The manifest pins every
plugin at an exact version and `omd` installs exactly those from the registry.

- To change a plugin: bump `version` in its `package.json` **and** its pin in `ohmydsh.json` (`pnpm run check:manifest`
  fails unless they are equal). Plugins you did not change keep their version, so only changed packages are published.
- To bump a community plugin, change its exact version in `ohmydsh.json`; CI installs the whole manifest into a clean
  profile and boots DSH before it can merge.
- To release: set `ohmydsh.json` `version` and the CLI's (`packages/cli/package.json`) to the new number, add a
  `## <version>` section to `CHANGELOG.md`, merge, then push the tag `v<version>`. `release.yml` runs every check, publishes
  the packages that are not on npm yet (with provenance), creates the GitHub Release from the changelog and builds the apps.
  It needs the repository secret `NPM_TOKEN`.
- CI also installs the whole set from packed tarballs (`pnpm run pack:all`, then `omd setup --manifest .tmp/tarballs/ohmydsh.json`)
  to catch a package that works linked but breaks once published.

## Pull requests

Keep them small and focused. CI must be green: package checks, CLI tests, the private-strings audit and the
integration job. Commits are authored under your own name or a GitHub noreply address; don't commit machine paths,
personal e-mails or credentials.

## Licences

Contributions are under the licence of the package they touch (see [NOTICE](NOTICE)): MIT, except `packages/studio`
and `packages/notebook`, which are Apache-2.0 and keep their LICENSE and NOTICE files in their folders.

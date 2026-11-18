# Contributing

Thank you for improving the Parallel Search provider for DeepSeek Harness.

## Scope

This package is intentionally a native DSH provider for search and fetch. Changes should
preserve the existing `web_search` tool and the provider-neutral `ctx.web`
boundary.

The following are not part of this package's current scope:

- a model-facing extract tool beyond the built-in `web_fetch`;
- a second model-facing or MCP tool;
- configurable API endpoints or retries;
- answer, session, model, location, freshness, or source-filter options; and
- compatibility claims beyond the pinned DSH release.

Propose broader product or API changes before implementing them.

## Set up

Prerequisites are Node.js `^22.19.0 || >=24.0.0`, Corepack, and pnpm. The
repository pins pnpm `11.7.0`.

```sh
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
```

Run the complete keyless validation suite:

```sh
pnpm run check
pnpm audit --prod
```

`pnpm run check` performs strict type checking, linting, deterministic tests,
the ESM/type build, manifest validation, and a package-content allowlist check.

## Verify the packed artifact

Create one fresh tarball and verify its exact contents:

```sh
PACK_DIR="$(mktemp -d)"
pnpm pack --pack-destination "$PACK_DIR"
PACK_TGZ="$PACK_DIR/t3labs-ohmydsh-web-search-parallel-0.1.0.tgz"
node scripts/verify-packed-artifact.mjs --tarball "$PACK_TGZ"
```

Use a disposable DSH home to prove the complete install lifecycle:

```sh
REVIEW_DSH_HOME="$(mktemp -d)"
DSH_HOME="$REVIEW_DSH_HOME" pnpm exec dsh --profile web --dump-config > "$REVIEW_DSH_HOME/before.yml"
DSH_HOME="$REVIEW_DSH_HOME" pnpm exec dsh plugin --profile web add "$PACK_TGZ"
DSH_HOME="$REVIEW_DSH_HOME" pnpm exec dsh --profile web --dump-config > "$REVIEW_DSH_HOME/after.yml"
node scripts/verify-packed-profile.mjs --dsh-home "$REVIEW_DSH_HOME" --expected-version 0.1.0
DSH_HOME="$REVIEW_DSH_HOME" pnpm exec dsh plugin --profile web remove @t3labs/ohmydsh-web-search-parallel
DSH_HOME="$REVIEW_DSH_HOME" pnpm exec dsh --profile web --dump-config > "$REVIEW_DSH_HOME/removed.yml"
node scripts/verify-profile-overlay.mjs \
  --before "$REVIEW_DSH_HOME/before.yml" \
  --after "$REVIEW_DSH_HOME/after.yml" \
  --removed "$REVIEW_DSH_HOME/removed.yml"
```

The packed-profile check verifies that the installed plugin and DSH profile
resolve one shared Cordis/web runtime. The overlay check proves the transition
`deepseek-official -> parallel -> deepseek-official` while preserving the
native `tool-web` row.

## Live end-to-end test

The normal test suite is credentialless. `pnpm run test:e2e` is opt-in because
it sends one real request each to Parallel Search and Parallel Extract and may consume account balance.
Export `PARALLEL_API_KEY` in the shell first, then run:

```sh
pnpm run test:e2e
```

Do not retry a failed live test automatically. Diagnose the failure first and
make another attempt only with the credential owner's authorization.

## Secrets and public artifacts

- Never commit API keys, tokens, `.env` files, request headers, or raw live API
  responses.
- Use obvious sentinel values and `.test` or loopback hosts in deterministic
  tests.
- Do not add local absolute paths, private repository facts, or planning
  artifacts to source, documentation, fixtures, logs, or package contents.
- Inspect `pnpm pack --dry-run` before release. Only the files listed in
  `package.json` may ship.
- Use `PARALLEL_LOG=info`, not `debug`, for routine endpoint/status evidence,
  and review logs before sharing them.

## Pull requests

Keep changes narrow and include the focused tests that prove the changed
contract. Before requesting review, run the keyless suite, production dependency
audit, and packed install/remove workflow above. State explicitly if the live
test was not run and why.

For help, contact [support@parallel.ai](mailto:support@parallel.ai).

# Parallel Search for DeepSeek Harness

`@parallel-web/dsh-web-search-parallel` is a search-only provider bundle for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It keeps
the harness's native `web_search` tool and routes that tool through
[Parallel Search](https://docs.parallel.ai/search/search-quickstart).

This release targets `@deepseek-ai/dsh@0.1.0-rc.6` on Node.js
`^22.19.0 || >=24.0.0`. DeepSeek Harness is a developer preview, so other DSH
versions are not covered by this compatibility claim.

## Prerequisites

- Node.js `22.19.0` or newer in the supported ranges above.
- DeepSeek Harness `0.1.0-rc.6`. The commands below run its CLI through
  `npx`, so a global `dsh` installation is not required.
- pnpm 10 or newer on `PATH`; `dsh plugin` delegates installation to pnpm.
- A [Parallel API key](https://platform.parallel.ai/).
- A separately configured DSH model provider. This package supplies web search,
  not the model that decides when to call `web_search` or writes the answer.

Confirm the two local tool versions before installation:

```sh
npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- dsh --version
pnpm --version
```

## Install

Set the key in the environment that launches DSH:

```sh
export PARALLEL_API_KEY="your-key"
```

This plugin is installed directly from its Git repository. Replace
`COMMIT_SHA` with the full commit SHA you want to install and keep the package
spec quoted:

```sh
npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- \
  dsh plugin --profile web add \
  --allow-build=@parallel-web/dsh-web-search-parallel \
  "github:parallel-web/dsh-web-search-parallel#COMMIT_SHA"
```

Then restart the profile:

```sh
npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- dsh --profile web
```

Git installs must run the package's `prepare` build. The package-scoped
`--allow-build` flag permits that script for this plugin only. Do not replace it
with a blanket build-script approval. The local tarball workflow below is
preferable when an already-built artifact is required.

### Install a local review tarball

From a checkout of this repository:

```sh
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm run check
PACK_DIR="$(mktemp -d)"
pnpm pack --pack-destination "$PACK_DIR"
```

Install the single `.tgz` created in `$PACK_DIR` into a disposable DSH home so
the review does not modify an existing profile:

```sh
REVIEW_DSH_HOME="$(mktemp -d)"
DSH_HOME="$REVIEW_DSH_HOME" npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- \
  dsh --profile web --dump-config > "$REVIEW_DSH_HOME/before.yml"
DSH_HOME="$REVIEW_DSH_HOME" npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- \
  dsh plugin --profile web add \
  "$PACK_DIR/parallel-web-dsh-web-search-parallel-0.1.0.tgz"
DSH_HOME="$REVIEW_DSH_HOME" npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- \
  dsh --profile web --dump-config > "$REVIEW_DSH_HOME/after.yml"
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the repository's exact packed
artifact and install/remove verification commands.

## Configure

Environment configuration is recommended because DSH configuration dumps are
readable text. The plugin accepts these bundle fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `apiKey` | string | `PARALLEL_API_KEY` | Parallel API key. An explicit empty string disables the provider. |
| `mode` | `turbo`, `basic`, or `advanced` | omitted | Parallel Search mode. Omission uses the API's `advanced` default. |
| `maxCharsTotal` | positive integer | `25000` | Maximum excerpt characters across the search response. |
| `maxCharsPerResult` | positive integer | omitted | Optional excerpt-character limit for each result. |

For non-secret overrides, edit the profile's user patch at
`$DSH_HOME/profiles/web/cordis.patch.yml` (normally
`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: web-search-parallel
  config:
    mode: turbo
    maxCharsTotal: 12000
    maxCharsPerResult: 2000
```

Do not put `apiKey` in this file unless you accept that it will appear in plain
text and in configuration dumps.

The plugin intentionally has no endpoint, retry, result-count, fetch, answer,
session, location, freshness, source-policy, or model option. DSH supplies the
result count and owns final source truncation.

## Verify

First inspect the effective profile without booting it:

```sh
npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- \
  dsh --profile web --dump-config
```

The dump should contain:

- one `web` row with `searchProvider: parallel`;
- the existing `tool-web` row; and
- one `web-search-parallel` row naming this package.

This proves bundle selection, not that a request reached Parallel. For a
runtime transport check, launch DSH with the SDK's information-level logging:

```sh
PARALLEL_LOG=info npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- \
  dsh --profile web
```

Trigger the existing `web_search` tool. A successful SDK log line identifies
`POST https://api.parallel.ai/v1/search` and its HTTP status, which is direct
evidence that the request used Parallel. Do not use `PARALLEL_LOG=debug` for
routine verification: debug mode emits substantially more request and response
metadata. Never paste logs without reviewing them for sensitive data.

## Troubleshooting

### The effective provider is still `deepseek-official`

Restart DSH after installation and rerun `--dump-config`. DSH applies the
profile's user patch after bundle patches, so inspect
`$DSH_HOME/profiles/web/cordis.patch.yml` for a later `web` override that
selects another provider.

### The provider is unavailable

Make sure `PARALLEL_API_KEY` is exported in the same shell or service
environment that starts DSH. An explicit `apiKey: ""` in profile configuration
intentionally suppresses the environment fallback.

### pnpm reports peer dependency warnings

This plugin deliberately uses DSH-owned Cordis, web, and launch-environment
peers so the profile has one shared runtime. DSH `0.1.0-rc.6` exposes those
packages through its profile-level parent fallback; the plugin does not install
private copies. Confirm the DSH version command in Prerequisites reports exactly
`0.1.0-rc.6`. Warnings that name different or missing peer versions indicate an
unsupported installation, not something to bypass with forced installs.

### DSH answers without searching

The configuration dump only proves which provider will handle `web_search`.
Your separately configured model still decides whether to call that tool. Use
a prompt that clearly needs current web information, then confirm the tool call
and the `PARALLEL_LOG=info` transport line.

### The request returns an HTTP or connection error

Check that the key is active, the machine can reach `https://api.parallel.ai`,
and the account can run Search. Retries are intentionally disabled, so one DSH
tool invocation corresponds to one SDK request attempt.

## Security and behavior

- Credential-bearing requests are fixed to `https://api.parallel.ai/v1/search`.
- `PARALLEL_BASE_URL` is ignored and redirects are rejected.
- SDK retries are disabled; DSH cancellation is forwarded to the request.
- The provider returns ordered citation sources with URLs, optional titles,
  joined excerpts, and optional publication dates. It returns no generated
  answer or full-page content.
- A missing key makes the selected provider unavailable without a network call.

This package does not provide `web_fetch` and does not call Parallel Extract.
Report security concerns according to [SECURITY.md](./SECURITY.md).

## Remove

```sh
npx --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 -- \
  dsh plugin --profile web remove @parallel-web/dsh-web-search-parallel
```

Restart the profile and rerun `--dump-config`. The base
`deepseek-official` search selection should be restored unless a user patch
selects something else.

## Development

The full keyless check is:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm audit --prod
```

The credentialed end-to-end test is deliberately separate and makes a real
Parallel Search request. Export `PARALLEL_API_KEY` in the shell first, then run:

```sh
pnpm run test:e2e
```

Run it only when you intend to spend a live request. Contributor setup,
artifact verification, scope, and secret-handling rules are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Support

For support, contact [support@parallel.ai](mailto:support@parallel.ai).

## License

MIT

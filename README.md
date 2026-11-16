# Parallel Search and Extract for DeepSeek Harness

This plugin makes DeepSeek Harness's built-in `web_search` tool use
[Parallel Search](https://docs.parallel.ai/search/search-quickstart) and its
built-in `web_fetch` tool use the
[Parallel Extract API](https://docs.parallel.ai/extract/extract-quickstart)
(page content as markdown). It does not add a new tool. Parallel fetches pages
server-side, so `web_fetch` through this provider cannot reach intranet or
local addresses, and each fetch counts against your Parallel usage.

It currently supports `@deepseek-ai/dsh@0.1.0-rc.6` on Node.js `^22.19.0 || >=24.0.0`.
DeepSeek Harness is still a developer preview, so later versions may
need a plugin update.

## Before you start

You will need:

- pnpm 10 or newer;
- a [Parallel API key](https://platform.parallel.ai/); and
- a model provider already configured in DeepSeek Harness.

You do not need to install `dsh` globally. The commands below run the supported
version through `npx`.

## Install

First, make your Parallel API key available in the terminal where you will run
Harness:

```sh
export PARALLEL_API_KEY="your-key"
```

Then install the plugin into the `web` profile:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web add \
  --allow-build=@parallel-web/dsh-web-search-parallel \
  "github:parallel-web/dsh-web-search-parallel#main"
```

The `--allow-build` flag lets pnpm build this plugin and nothing else. For a
reproducible install, replace `main` with a full commit SHA.

Stop any running Harness process, then start it again:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

## Check that it worked

Inspect the profile:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile web --dump-config | \
  grep -E 'searchProvider: parallel|web-search-parallel'
```

You should see `searchProvider: parallel`, `fetchProvider: parallel` and a
`web-search-parallel` entry.
Seeing the built-in `web-search-deepseek` plugin as well is normal—the
`searchProvider` setting decides which provider handles searches.

For direct request evidence, start Harness with information-level Parallel
logging:

```sh
PARALLEL_LOG=info npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

After a `web_search` call, the terminal should show a successful request to
`https://api.parallel.ai/v1/search`. Review logs before sharing them.

## Optional settings

The defaults work without extra configuration. If you want to tune the search,
edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: web-search-parallel
  config:
    mode: turbo
    maxCharsTotal: 12000
    maxCharsPerResult: 2000
```

| Setting | Default | What it controls |
| --- | --- | --- |
| `mode` | Parallel's `advanced` default | `turbo`, `basic`, or `advanced` search |
| `maxCharsTotal` | `25000` | Total excerpt characters returned to Harness |
| `maxCharsPerResult` | no limit | Excerpt characters kept for each result |
| `maxFetchChars` | `100000` | Characters of page content `web_fetch` returns before truncating |

Keep `PARALLEL_API_KEY` in the environment rather than putting it in this file,
which is stored as readable text.

## Pinning both providers

The bundle's patch row sets `searchProvider: parallel` and
`fetchProvider: parallel` on the `web` entry. A patch row with the same `id`
**replaces that entry's whole `config`**, so if you write your own `web` row,
list both fields. Leaving `fetchProvider` out makes DeepSeek Harness fail
`web_fetch` with `multiple usable web providers are registered ... configure one
explicitly` whenever more than one fetch provider is usable (for example the
built-in `http` and `deepseek-fetch-api` providers).

## If something goes wrong

- **`web_fetch` says multiple usable web providers are registered:** the `web`
  row lost `fetchProvider`. Set `fetchProvider: parallel` (see above).

- **`dsh` is not found:** use the `npx @deepseek-ai/dsh` commands above.
- **Port 3080 is already in use:** stop the older Harness process before
  starting another one.
- **The provider is still `deepseek-official`:** restart Harness and check
  whether your `cordis.patch.yml` contains a later `searchProvider` or
  `fetchProvider` override.
- **pnpm reports missing DSH peer dependencies:** this warning is expected for
  this Git install. Harness supplies those packages from the profile runtime.
- **Harness answers without searching:** the configured model decides when to
  call `web_search`. Try a prompt that clearly requires current information.
- **The provider is unavailable:** confirm `PARALLEL_API_KEY` is set in the same
  terminal that starts Harness.

## Remove

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  plugin --profile web remove @parallel-web/dsh-web-search-parallel
```

Restart Harness after removing the plugin.

## Development and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local development, tests, and the
packed-artifact review workflow. Report vulnerabilities according to
[SECURITY.md](./SECURITY.md).

For help, contact [support@parallel.ai](mailto:support@parallel.ai).

MIT licensed.

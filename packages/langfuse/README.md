# dsh-langfuse

Rich [Langfuse](https://langfuse.com) tracing for DeepSeek Harness (DSH). One trace per agent turn, Langfuse sessions mapped to DSH sessions, generations with usage and timing, tool spans, subagent nesting, and an **Open trace** button under every assistant message.

Design and code are ported from [pi-observability-plugin](https://github.com/langfuse/pi-observability-plugin) (MIT): the redaction rules, the usage/cost key spellings and the isolated OTel provider.

## How it hooks in

| Signal | Source |
|---|---|
| Turn, step, tool, approval, compaction, retry spans | durable `session/event` log |
| Generations (input, output, usage, TTFT, latency) | observe-only tap on the global `llm/stream` waterfall; also covers titles and compaction summaries |
| Subagent linkage | `subagent/start` / `subagent/end` + session `parentSession` |
| Origin (`user`, `schedule`, `goal`, `sentinel`, …) | `user/message.source.kind` |

The plugin owns a private `NodeTracerProvider` + `@langfuse/otel` span processor and never installs a global OTel provider. The tap never changes or throws into the stream. Flush happens at turn end and on shutdown.

## Install (dev)

```sh
pnpm install && pnpm run check
dsh plugin --profile <profile> add "dsh-langfuse@link:$PWD"
# then restart DSH
```

Configuration and privacy notes: [docs/DETAIL.md](docs/DETAIL.md).

## Trace model

```
session (DSH root session id)
└ trace = one turn          "Turn N" (agent)   id = sha256("<session>:<turn/start seq>")[0:32]
   ├ Step k                                       span
   │  ├ LLM: <model>                              generation (usage, cost, ttft, latency)
   │  ├ Tool: <name>                              tool (ERROR on failure)
   │  │  └ Subagent: <preset> · turn n            agent, same trace
   │  ├ Approval: <tool>                          span (human wait time)
   │  └ Retry #n                                  event
   └ Compaction                                   span (+ summariser generation)
```

## Open trace

The button calls `langfuse/traceFor` on the Host, which rebuilds the deterministic trace id from the session log and builds the URL from the project that owns the configured key pair (resolved via `GET /api/public/projects`).

## License

MIT, see [LICENSE](LICENSE). Ported from pi-observability-plugin (MIT, Langfuse GmbH); see [NOTICE](NOTICE). UI controls in `src/kit/` are adapted from `@deepseek-ai/dsh-client-ui-primitives` (MIT, Copyright (c) 2026 DeepSeek); see [NOTICE](NOTICE).

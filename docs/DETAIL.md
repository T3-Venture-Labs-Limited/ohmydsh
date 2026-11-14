# Langfuse tracing

Every agent turn becomes one Langfuse trace, grouped by DSH session. Open any trace from the button under an assistant message.

## What you get

- **One trace per turn.** The trace id is derived from the session and turn, so it is stable and the **Open trace** button can find it again after a restart. The Langfuse *session* is the DSH session; subagent turns share the root session id.
- **Model calls as generations**: model, provider, reasoning effort, full input and output, token usage (input, output, reasoning, cache read, cache write), time to first token, latency and tokens per second. Failed calls are marked as errors.
- **Tools** with arguments and results; failing tools show as errors.
- **Subagents** nested under the tool call that started them, inside the same trace.
- **Approvals, retries and compaction** as their own observations. Turns started by a schedule, goal or sentinel carry the origin in their metadata, and cancelled turns say why.
- **Auxiliary calls** such as title generation and compaction summaries are traced too, and can be excluded.

## Setup

Set the Langfuse keys in the Host environment:

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=http://127.0.0.1:3001   # default
LANGFUSE_TRACING_ENVIRONMENT=dsh          # default
```

`LANGFUSE_TRACING_ENABLED=false` switches tracing off. Without keys the plugin stays idle and the Settings page says why.

## Options

Set these under the plugin's `config`: `captureContent` (`full`, `metadata`, `off`), `includeReasoning`, `includeSystemPrompt`, `maxChars`, `sampleRate`, `excludePurposes`, `redactTools`, `tags`, `pricing` (USD per 1M tokens, for models Langfuse cannot price), `flushTimeoutMs`, `openTraceButton`.

## Privacy

Full prompts, tool arguments and outputs are sent to your Langfuse server. Known secret shapes (bearer tokens, vendor keys, URL credentials, `*_API_KEY=` assignments, environment secrets) and inline binary data are removed before export, and very large payloads are cut to a head and tail excerpt. Use `redactTools` for tools whose content must never leave the machine.

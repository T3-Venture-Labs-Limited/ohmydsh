# Upstream issue draft: dsh-sentinel (github.com/fuhefei/dsh-sentinel)

Verified against 0.15.0 (`lib/index.js`, delivery near `~2765-2795`).

**Problem.** A watch wake-up always runs on the registering session's current model. Sentinel never creates a session, it resumes the registering one (with `agentDefaultModel.currentSelection()` as the route for a dormant resume) and calls `agent.followup(createUserMessage({ source: { kind: 'sentinel' } }))`. `Config` has no model option, so polling-style watches ("every 5 min check CI") burn the user's most expensive model.

**Requests.**

1. `sentinel_watch` accepts an optional `model: { provider, model, reasoningEffort? }`, stored in the sidecar subscription row (the schema versioning note in the README applies: older readers reject the new rows).
2. The wake-up source carries the watch id structurally: `source: { kind: 'sentinel', watchId }`, so listeners no longer need to parse `watch-N` out of the rendered title (ambiguous across batches).
3. Optional soft integration: if `ctx.get('automationModels')` exists, call `applyTo(agent, route)` before `agent.followup`; otherwise do nothing. No hard dependency.

**Workaround today.** `dsh-automation-models` has a per-source default for `sentinel` and switches the session's model for the wake-up turn through the global `agent/inbox/claimed` hook, restoring it at idle.

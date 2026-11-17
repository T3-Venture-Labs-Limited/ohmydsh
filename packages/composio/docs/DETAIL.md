# Composio

Use your Composio apps from DSH, and let events from them start or wake agent sessions.

**For the agent**

- `composio_search`, `composio_execute`, `composio_link`, `composio_status` wrap the Composio CLI you are already logged in with.
- Read-only tools run directly. Anything that writes or deletes asks for your approval first.
- `composio_link` only returns a Connect URL for you to open; the agent cannot finish OAuth.

**The Composio page** (sidebar)

- *Connections*: apps and accounts with Active / Expired status, re-authorise and add account.
- *Tools*: browse an app's tools with a risk tag, view the input schema, dry-run.
- *Triggers*: a route watches one trigger on one account and hands each event to a recipe, in a new session or in an existing one.
- *Recipes*: a prompt template, the allowed apps and tools, file access and model.
- *Runs*: every event with its result.

**Safety**

- Event data is added to the prompt as fenced, escaped, untrusted data. Only the recipe's own text is trusted.
- Trigger-run sessions get only `composio_*` and read-only file tools. A Composio tool outside the recipe's allowlist pauses for your approval (dsh-notify-me notifies you).
- Per-route rate limits, a circuit breaker after 3 failures in a row, and a global "pause all" switch.

**Good to know**

- Events arrive over an outbound realtime connection; nothing is exposed to the internet. Events sent while DSH is not running are lost.
- If the dsh-automation-models plugin is installed, the "Composio triggers" source appears on its page for model overrides.

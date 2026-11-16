![The Triggers page: automations with their source, last run and an enabled switch](preview.svg)

# Triggers

Run an agent when something happens. Each automation is a **source**, a **target chat** and a **prompt**.

**Sources**

- *Webhook*: `POST /hooks/<id>` on this DSH server, authenticated with a bearer token, a GitHub-style HMAC signature, Standard Webhooks, or nothing (this computer only). Optional event-type filter.
- *File*: a new file whose name matches a pattern in a watched folder, once it has stopped changing. Optional condition on a JSON file next to it (for example `metadata.json` `status = completed`).
- *Composio*: events routed here by the dsh-composio plugin.

**Targets**

- A new chat per event, or one chat that every event is added to.
- Workspace folder, model (or the profile default) and reasoning effort, read-only or editable files, read-only or normal tools, and a chat title template.

**The Triggers page** (sidebar, under Automation tasks)

- Templates: *Meeting summary (voxtype)*, *Generic webhook*, *GitHub webhook*, *Folder drop*, *Composio trigger*.
- Preview the exact prompt, fire a test event, copy the webhook URL and a `curl` example, rotate the secret.
- Recent runs with their status and an **Open chat** button. A **Pause all** switch stops everything.

**Safety**

- Only your prompt is trusted; the event is inserted as fenced, escaped, untrusted data.
- Webhook secrets are shown once. Rate limits per automation and overall; an automation turns itself off after 3 failed deliveries.

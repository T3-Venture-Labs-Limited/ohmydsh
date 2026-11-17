# Automation models

Run your automations on a cheaper model, without touching your own conversations.

**What it does**

- When a scheduled task, a sentinel wake-up (or any plugin that registers a source) delivers a message to a session, that turn runs on the automation model: **Claude Sonnet 5.5, low effort** by default.
- When the turn ends, the session returns to the model it had before. If you picked another model in the meantime, your choice wins.
- Your profile's default model is never changed.

**The page** (sidebar → *Automation models*)

- *Defaults per source*: choose provider, model and effort per source, or "Session's own model" to opt a source out.
- *Scheduled tasks*: override the model for one task; "Keep this model after the run" skips the restore.
- *Recent notices*: shows when a chosen model was unavailable and a fallback was used.

**Good to know**

- If several tasks are due for the same session at once, the first one decides the model.
- DSH adds a short "model changed" note to the transcript on each switch.
- Plugins can add their own sources through the `automationModels` host service (see the README).

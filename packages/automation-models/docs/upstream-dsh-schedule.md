# Upstream issue draft: dsh-schedule (deepseek-ai/deepseek-harness, `packages/schedule`)

Verified against 0.2.2-rc.3. Two small, back-compatible requests that remove a text-parsing stopgap and give automations a first-class model.

## 1. Structured task id on the message source

**Problem.** Plugins that react to schedule deliveries (per-task model, notifications, accounting) must parse the reminder text (`schedule_id_json: "..."` or `reminders_json: [...]`), because `MessageSourceMap['schedule']` is just `{ kind: 'schedule' } & ContextFormed` (`runtime.ts:5-9`, message created at `runtime.ts:353`). The `[SCHEDULE CHANGE]` notice injected from `index.ts:706-733` shares the same `kind`, so listeners also have to sniff the text header to tell a delivery from a notice.

**Proposal.**

```ts
'schedule': { kind: 'schedule' } & ContextFormed & (
  | { run: 'reminder'; taskId: ScheduleId; occurrenceAt: string }
  | { run: 'batch'; tasks: { taskId: ScheduleId; occurrenceAt: string }[] }
  | { run: 'change'; taskId: ScheduleId; change: ScheduleChangeKind }
)
```

Optional fields so older logs stay valid. Listeners on `agent/inbox/claimed` can then switch on `message.source.run`.

## 2. First-class model for delivery

**Problem.** `ScheduleSessionCreateSpec` is `{ cwd?, agentPreset? }` (`types.ts:345-350`, strict zod in `storage.ts:46-49`). Every `new` / `new_once` session starts on `agentDefaultModel.currentSelection()`, so a routine "check the inbox every hour" task runs on the user's most expensive default. `session` targets have no delivery-model concept at all.

**Proposal.** Add `model?: { provider; model; reasoningEffort? }` to the create spec and a task-level `deliveryModel` for `session` targets. Apply it with `agent.model.select()` right after `activate` (new sessions) or at claim time (existing sessions, restored at idle), never through `sessionController.selectModel` (that also saves the global default, `commands.ts:180`). Surface it in the task editor (`TaskEditorFields.tsx`) with the shared model catalog.

**Related.** A `schedule.task.editor.extra` slot in `dsh-client-ui-schedule` would let plugins add editor rows without forking.

**Workaround today.** `dsh-automation-models` switches the model in a global `agent/inbox/claimed` listener and restores it at idle; its schedule-id parsing can be deleted once (1) lands.

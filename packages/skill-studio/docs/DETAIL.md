# Skill studio

One page for every agent skill DSH can see.

- **See everything.** Skills from `~/.agents/skills`, `~/.dsh/skills`, the project's `.agents/skills` and `.dsh/skills`, custom folders and plugins. Skills DSH silently drops are shown too: shadowed duplicates ("Hidden by ~/.dsh") and files with broken frontmatter, with the reason.
- **Disable in DSH only.** The switch hides a skill from the model's catalog, the `skill` tool, `/name` and the `/` menu. Skill files are never touched, so Claude Code, pi and other agents keep using them. Optionally override per workspace.
- **Edit safely.** A textarea editor with live checks that use the same rules as DSH's loader, a backup of the previous version before every save, an optimistic lock if the file changed on disk, and a clear read-only notice for system or plugin skills. Open any skill in the sidebar editor.
- **Create skills.** A form writes `<name>/SKILL.md` to `~/.agents/skills` (shared), `~/.dsh/skills` (DSH only) or the project.
- **Suggestions from the agent.** A `propose_skill` tool lets the agent suggest a new skill or an improvement. It only queues the suggestion: nothing is written until you approve it. A card appears under the turn (and in the **Proposals** tab, with a count on the sidebar icon) showing the full SKILL.md or a diff, with **Approve**, **Edit**, **Reject** and **Reject and don't suggest again**. Approvals are re-validated, written with a backup, and a rejected suggestion never leaves a file.
- **Review finished sessions (optional, off by default).** After a session goes idle, and once a day, a cheap model (default Claude Haiku 5.5, low effort) reads a redacted transcript, tool calls but never tool outputs, and may queue suggestions. A pattern needs two sessions or high confidence. Daily token budget, per-run limits, excluded folders and a run log are in the **Suggestions** tab. If the Automation models plugin is installed, the model is chosen there (source "Skill reviewer").
- **Usage counts** from `skill` tool calls and `/name` invocations in your session history.

Limits: disabling is by skill name (a disabled name also hides any shadowed duplicate). The `/` menu in a conversation that is already open refreshes after a reload or a new session; the model and `/name` obey immediately. If DSH changes the skill registry in a future release, disabling switches itself off with a notice (editing and creating keep working).

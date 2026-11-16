# Agent browser takeover

Companion to **dsh-agent-browser**. It shows each conversation's browser live in a right-sidebar tab, lets you take control of it, and pauses the agent while you do.

## Use it

1. Open the **Agent browser** tab from the right sidebar's new-tab list. It shows the current conversation's browser.
2. Click **Take control**, then click into the page and type. Ctrl+V pastes your clipboard. The agent's `browser_*` tools are refused while you hold control.
3. Click **Hand back** (optionally with a note for the agent) to return control. Your logins from that browser are saved for every later browser.

The agent can call `browser_request_human` with a reason, for example "Sign in to GitHub". The tab opens in that conversation, a banner appears above its composer, and the agent waits until you hand back.

## Parallel conversations and logins

- Every conversation gets its own browser and Chrome profile under `~/.agent-browser/dsh/sessions/`, so agents in different projects browse at the same time without interfering.
- Each new browser starts from the shared login store `~/.agent-browser/dsh/logins.json` (cookies and local storage, readable only by you).
- Logins reach the store when you hand a browser back, or when an agent calls `browser_save_logins` after signing in itself. A browser that is already running picks up new logins the next time it starts.
- Session cookies (the kind that end when a browser closes) are not shared. Two agents on the same site share one account.
- A conversation's browser shuts down after 30 idle minutes; its profile stays. Profiles unused for 14 days are deleted.

## Limits

- Needs dsh-agent-browser and dsh-better-sidebar. Without better-sidebar there is no tab; the composer banner still appears.
- The view is a screencast. Native dialogs, file pickers and drag-and-drop from your desktop do not pass through.

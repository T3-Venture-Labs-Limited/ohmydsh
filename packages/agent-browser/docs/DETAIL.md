# Agent browser

Gives the agent nine `browser_*` tools (open, snapshot, find, act, get, eval, screenshot, tabs, session) that drive Chrome through [agent-browser](https://github.com/vercel-labs/agent-browser), and shows the page it is working on in a live panel.

- **A small, draggable browser button.** The collapsed button is a round monitor icon with a count badge. Drag it anywhere along the left or right edge; it snaps to the nearer edge, stays inside the visible screen (also above the on-screen keyboard) and remembers its place per window size. A tap opens the panel next to it. The default spot is the middle of the right edge, away from the send button.
- **Quiet when idle.** The panel polls its session list only while the page is visible and slows down while nothing changes.
- **Takeover.** Hold human control of the page from the panel; your input never goes through the model.
- **Safe by default.** Cookies are redacted, `browser_eval` goes through the approval prompt, and off-list domains need a grant.

Settings live in the `browser` row (Settings > Plugins): `autoOpenPanel`, `idleTimeoutMinutes`, `defaultTimeoutMs`, `allowedDomains`, `headed`.

This is a modified build of [dsh-agent-browser](https://github.com/shantanugoel/dsh-agent-browser) 0.2.7 (MIT). See UPSTREAM.md for what differs.

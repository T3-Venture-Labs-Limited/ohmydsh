# @t3labs/ohmydsh-agent-browser

Native browser automation for DSH: nine `browser_*` model tools driving [agent-browser](https://github.com/vercel-labs/agent-browser)
(Chrome through CDP), and a live-view panel in the web GUI to watch the page, take control and hand it back.

This is a modified build of [dsh-agent-browser](https://github.com/shantanugoel/dsh-agent-browser) 0.2.7 by its contributors (MIT).
Changes: a small, draggable collapsed browser button (it no longer covers the phone send button) and an idle back-off for the
panel's session poll. See [UPSTREAM.md](UPSTREAM.md). It installs as part of ohmydsh and replaces the `dsh-agent-browser` package; the `browser` row id
is the same, so settings carry over.

```yaml
- id: browser
  config:
    headed: false
    idleTimeoutMinutes: 30
    allowedDomains: ["example.com"]
    autoOpenPanel: true
```

Needs Node 24.9+ and Chrome (system Chrome is used automatically; otherwise run `agent-browser install` once).

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

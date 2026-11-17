# HUD

A fast popup chat for DSH: press a key, type, get a streamed answer, press Esc. This plugin is the **host half**: it serves the Qt app ([dsh-hud-qt](https://github.com/dsh-plugins/dsh-hud-qt)) over a local Unix socket.

## What it does

- Lists your sessions and workspaces and creates a fresh HUD chat with a cheap default model (`claude-haiku-5-5`, low effort, configurable).
- Streams a session's transcript to the HUD and relays prompts, cancel and per-session model selection.
- "Open in web" opens the session in the DSH web UI (plain URL; your browser's existing login is used).

## Off by default

The bridge is **disabled until you set `enabled: true`** in the plugin config.

## Trust boundary

The socket accepts any process of your user. The HUD will not prompt, re-model or create sessions that run in `danger-full-access` mode unless you set `allowDangerousSessions: true`. It never exposes a login token. See the README for details.

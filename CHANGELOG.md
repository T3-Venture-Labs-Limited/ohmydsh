# Changelog

Each release is one version of [`ohmydsh.json`](ohmydsh.json): the tested set of DeepSeek Harness, our plugins and the
community plugins. Add a section here before tagging; the text under the version heading becomes the GitHub Release notes.

## Unreleased

- Follow upstream: a daily workflow (`follow.yml`) tests the newest DeepSeek Harness and community plugin versions against the whole set (install from tarballs, every pack, web boot, and `omd update` from the last release, on Linux and macOS) and releases what passes, by itself. What fails gets one `follow` issue per package; a `hold` issue keeps a package where it is. `release.yml` can also be started with a tag.
- CLI (`omd`): `omd update` and `omd setup` move DeepSeek Harness together with the profile when the set pins another version. The new DSH is tried in a temporary folder first and switched last; the lock records the previous one, `omd rollback` restores both and `omd doctor` reports a mismatch. `--no-dsh-install` (and a DSH omd did not install, like the desktop app's) is never touched.
- Brand (`@t3labs/ohmydsh-brand` 0.1.0, new, on by default): DSH now shows ohmydsh instead of the DeepSeek Harness logo and name: the sidebar mark and wordmark (expanded and collapsed), the new-session mark, the tab title and favicon (light and dark), the loading screen and the installed-app icons. Settings → General says "Built on DeepSeek Harness" with a link to DeepSeek's page, so it stays clear what ohmydsh is. Turn it off with `enabled: false` in the `ohmydsh-brand` row. The phone-app name defaults to ohmydsh too (`dsh-pwa` row `name`/`shortName`).

## 0.1.3

- Agent browser (`@t3labs/ohmydsh-agent-browser` 0.2.8, replaces the community `dsh-agent-browser`): our build of dsh-agent-browser 0.2.7 with a small, draggable browser button. It no longer covers the send button on a phone, snaps to the left or right edge, stays above the on-screen keyboard and remembers its place per window size. The panel's session poll also stops while the tab is hidden and slows down while idle. The `browser` row id is unchanged, so settings carry over; `omd update` removes the old package. Credit and differences: `packages/agent-browser/UPSTREAM.md`; both changes are proposed upstream.
- Browser takeover (0.1.1): follows the renamed agent-browser package in its settings row.

## 0.1.2

- Desktop (Linux): the app no longer crashes DSH on the first image job. It now ships the official Node.js 24.22.3 and runs DSH on it instead of on Electron, because sharp (image handling) segfaults under Electron-as-Node on Linux. macOS and Windows still run DSH on Electron's Node. `OHMYDSH_NODE=/path/to/node` overrides the choice.
- Desktop: the launchers (`node`, `dsh`, `omd`) are rewritten on every start, so they follow the AppImage's new mount path each launch. The smoke tests now run a sharp image job under the runtime the app really uses.
- CLI (`@t3labs/ohmydsh`): `omd doctor` no longer misreads a provider's nested model ids as missing rows, which blocked the desktop app's first start after a profile move.

## 0.1.1

- Theme (`@t3labs/ohmydsh-theme` 0.1.1): keeps the Omarchy colours when the community theme dsh-theme-endfield is installed, while its square corners stay.
- Desktop: platform-independent paths and tests, so the Windows and macOS builds pass their checks.
- Release: the CLI test glob and the review-comments sync test are stable on CI.

## 0.1.0

First release.

- **`omd` command** (`npm i -g @t3labs/ohmydsh`): `setup`, `add`, `remove`, `update`, `rollback`, `doctor`, `list`. It installs into its
  own DSH profile (`omd`), tested as a set, with rollback.
- **Phones keep connecting after a reboot**: `omd setup`/`update` save this machine's Tailscale name (and any
  `--trusted-host`) in the profile, so DSH accepts it even when it starts before Tailscale. `omd doctor` warns if it is missing.
- **Our plugins**, published as `@t3labs/ohmydsh-*`: Studio, Phone app, Browser takeover, Review comments, Skill studio, Notebook,
  Triggers, Automation models; optional packs Composio, Langfuse, Parallel web search, and Omarchy (Theme, HUD).
- **Community plugins** pinned from npm at tested versions (subscriptions, memory, genui, better sidebar and more).
- **Desktop app** (Windows, macOS, Linux; unsigned for now) and **Android app**, attached to this release.
- Tested with DeepSeek Harness 0.2.2-rc.3.

Upgrading from the standalone plugin repos: plugin settings are kept (row ids did not change). Remove the old `dsh-*` packages
from your profile before adding the new ones.

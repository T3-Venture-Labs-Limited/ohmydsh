# Changelog

Each release is one version of [`ohmydsh.json`](ohmydsh.json): the tested set of DeepSeek Harness, our plugins and the
community plugins. Add a section here before tagging; the text under the version heading becomes the GitHub Release notes.

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

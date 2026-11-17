# dsh-kit

A starting point for DeepSeek Harness (DSH) plugins. It is a toolbox, not a plugin: nothing here is installed into DSH.

- **UI kit** (`ui/`): React controls that look and behave like DSH's own (buttons, switch, segmented control, text field, select, modal, tooltip, settings page patterns). Copy the folder into your plugin as `src/kit/`.
- **Token linter** (`lint/token-lint.mjs`): fails the build when a stylesheet or source file uses a `--dsw-*` theme token DSH does not define, or a literal colour outside artwork, so a plugin keeps following the active DSH theme.
- **Plugin template** (`template/` and `scripts/new-plugin.sh`): generates a working plugin (Host half, browser half, settings page, sidebar panel, tests, build and an artifact check) ready for `dsh plugin add`.

See the README for usage and [NOTICE](../NOTICE) for the origin of the controls.

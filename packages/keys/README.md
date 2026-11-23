# @t3labs/ohmydsh-keys

Answer DeepSeek Harness **approval** and **question** cards with the keyboard. On by default in the ohmydsh core set; it uses
DSH's extension points (the shortcut service, index injection) and the rendered DOM of the two cards, nothing on disk is patched.

| Card | Keys |
|---|---|
| Approval | `1` allow once · `2` always allow (if offered, else reject) · `3` / `Esc` reject · `Enter` allow once (never "always") |
| Question, single choice | `1`–`9` pick · `↑` `↓` move · `Enter` confirm / next question |
| Question, multiple choice | `1`–`9` or `Space` toggle · `↑` `↓` move · `Enter` confirm |
| Any question | `Tab` to the "Other" box (`Esc` back) · `←` `→` previous / next question · `Ctrl`+`Backspace` skip |
| Anywhere | `Ctrl+Alt+J` (`⌘⌥J` on a Mac, rebindable in Settings → Shortcuts) focuses the waiting card |

See `docs/DETAIL.md` for the user-facing description.

## How it works

One capture-phase `keydown` listener on the document (`src/client/controller.ts`). A key that lands inside a card is mapped by the
pure functions in `src/client/keymap.ts` and executed by **clicking DSH's own controls** (`src/client/dom.ts` is the only file
that knows the card markup), so DSH's locks, scopes and request identity stay in charge. Hints and number badges are plain
attributes (`data-ohmydsh-key*`, `aria-keyshortcuts`) painted with CSS pseudo-elements from theme tokens; no node is inserted into
DSH's React tree.

Rules that keep it safe:

- Plain keys act only while focus is inside the card (focus is moved there when the card appears, or by `Ctrl+Alt+J`), so a digit never reaches the composer.
- No auto-focus while you type: focus in a text field with text in it, or a keystroke in the last 1.5 s, shows a "Ctrl+Alt+J to answer" hint instead.
- Key repeat is ignored (and swallowed until the key is released, so a held `Enter` cannot press Send afterwards); IME composition is ignored.
- Only a card that is connected, visible and not already answering reacts; with several cards (sessions, split views) the one you are in does.
- No effect on touch devices; the hint line is hidden under 600 px.

## Shortcut service

The service only accepts modified combinations as editable shortcuts (plain keys are "reserved" on Linux and in browsers), so
`ohmydsh.keys.focus` is the one rebindable command: default `Ctrl+Alt+J` (`⌘⌥J` on macOS) in the desktop app and in a browser on Windows/macOS; in a browser on Linux a fixed,
not rebindable `Ctrl+Alt+J` row (browsers accept few editable combinations). Plain `Ctrl+J` is not used: the ohmydsh set already
ships `dsh-hotkey`, whose session switcher owns it. The plain keys are registered as read-only
reference rows so they show in Settings → Shortcuts and cannot be given to another command.

## Config

```yaml
- id: ohmydsh-keys
  name: '@t3labs/ohmydsh-keys'
  config:
    enabled: true     # false: stock behaviour, nothing is registered
    autoFocus: true   # false: a new card never takes the focus (it shows the Ctrl+Alt+J hint)
```

## Guarding against DSH updates

`tests/selector-guard.spec.ts` reads the installed DSH sources and bundle (`@deepseek-ai/dsh-client-ui-approval`,
`@deepseek-ai/dsh-client-ui-user-questions`) and fails when `data-approval-key`, `data-question-key`, the option roles and
`aria-checked`, the approval button order, or the question pager/skip structure change. The daily follow job runs it.

## Develop

```sh
pnpm install
pnpm run check      # typecheck, oxlint + token lint, vitest, tsdown build, artifact check
```

## Licence

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). ohmydsh is unofficial: DeepSeek did not make it and does not endorse it.

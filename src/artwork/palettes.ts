// Community palette data (artwork: literal colours live here by design, as ~20 keys each instead of 380 tokens).
// Values are the published palettes of each scheme; Omarchy-key names so one generator serves all of them.
import type { Colors, Mode } from '../shared/omarchy.ts'

export interface PaletteDef {
  id: string
  name: string
  mode: Mode
  colors: Colors
}

/** Fill the Omarchy keys a scheme does not define from the ones it does. */
function make(id: string, name: string, mode: Mode, p: {
  bg: string; bgDark: string; bgLight: string; sel: string; muted: string
  fg: string; fgDim: string; fgSoft: string; accent: string
  red: string; yellow: string; orange: string; green: string; cyan: string; blue: string; magenta: string
}): PaletteDef {
  return {
    id, name, mode,
    colors: {
      background: p.bg, dark_background: p.bgDark, darker_background: p.bgDark, lighter_background: p.bgLight,
      foreground: p.fg, dark_foreground: p.fgDim, light_foreground: p.fgSoft, bright_foreground: p.fg,
      accent: p.accent, selection: p.sel, muted: p.muted,
      red: p.red, yellow: p.yellow, orange: p.orange, green: p.green, cyan: p.cyan, blue: p.blue, magenta: p.magenta,
      brown: p.orange,
    },
  }
}

/* artwork:start */
export const PALETTES: readonly PaletteDef[] = [
  make('catppuccin-mocha', 'Catppuccin Mocha', 'dark', {
    bg: '#1e1e2e', bgDark: '#181825', bgLight: '#313244', sel: '#45475a', muted: '#585b70',
    fg: '#cdd6f4', fgDim: '#6c7086', fgSoft: '#a6adc8', accent: '#89b4fa',
    red: '#f38ba8', yellow: '#f9e2af', orange: '#fab387', green: '#a6e3a1', cyan: '#94e2d5', blue: '#89b4fa', magenta: '#f5c2e7',
  }),
  make('catppuccin-latte', 'Catppuccin Latte', 'light', {
    bg: '#eff1f5', bgDark: '#e6e9ef', bgLight: '#ccd0da', sel: '#ccd0da', muted: '#acb0be',
    fg: '#4c4f69', fgDim: '#9ca0b0', fgSoft: '#5c5f77', accent: '#1e66f5',
    red: '#d20f39', yellow: '#df8e1d', orange: '#fe640b', green: '#40a02b', cyan: '#179299', blue: '#1e66f5', magenta: '#ea76cb',
  }),
  make('dracula', 'Dracula', 'dark', {
    bg: '#282a36', bgDark: '#21222c', bgLight: '#343746', sel: '#44475a', muted: '#6272a4',
    fg: '#f8f8f2', fgDim: '#6272a4', fgSoft: '#c0c2d0', accent: '#bd93f9',
    red: '#ff5555', yellow: '#f1fa8c', orange: '#ffb86c', green: '#50fa7b', cyan: '#8be9fd', blue: '#6272a4', magenta: '#ff79c6',
  }),
  make('gruvbox-dark', 'Gruvbox Dark', 'dark', {
    bg: '#282828', bgDark: '#1d2021', bgLight: '#3c3836', sel: '#504945', muted: '#665c54',
    fg: '#ebdbb2', fgDim: '#928374', fgSoft: '#bdae93', accent: '#fabd2f',
    red: '#fb4934', yellow: '#fabd2f', orange: '#fe8019', green: '#b8bb26', cyan: '#8ec07c', blue: '#83a598', magenta: '#d3869b',
  }),
  make('gruvbox-light', 'Gruvbox Light', 'light', {
    bg: '#fbf1c7', bgDark: '#f2e5bc', bgLight: '#ebdbb2', sel: '#d5c4a1', muted: '#bdae93',
    fg: '#3c3836', fgDim: '#928374', fgSoft: '#504945', accent: '#b57614',
    red: '#9d0006', yellow: '#b57614', orange: '#af3a03', green: '#79740e', cyan: '#427b58', blue: '#076678', magenta: '#8f3f71',
  }),
  make('solarized-dark', 'Solarized Dark', 'dark', {
    bg: '#002b36', bgDark: '#00212b', bgLight: '#073642', sel: '#073642', muted: '#586e75',
    fg: '#93a1a1', fgDim: '#586e75', fgSoft: '#839496', accent: '#268bd2',
    red: '#dc322f', yellow: '#b58900', orange: '#cb4b16', green: '#859900', cyan: '#2aa198', blue: '#268bd2', magenta: '#d33682',
  }),
  make('solarized-light', 'Solarized Light', 'light', {
    bg: '#fdf6e3', bgDark: '#eee8d5', bgLight: '#eee8d5', sel: '#eee8d5', muted: '#93a1a1',
    fg: '#586e75', fgDim: '#93a1a1', fgSoft: '#657b83', accent: '#268bd2',
    red: '#dc322f', yellow: '#b58900', orange: '#cb4b16', green: '#859900', cyan: '#2aa198', blue: '#268bd2', magenta: '#d33682',
  }),
  make('nord', 'Nord', 'dark', {
    bg: '#2e3440', bgDark: '#272c36', bgLight: '#3b4252', sel: '#434c5e', muted: '#4c566a',
    fg: '#d8dee9', fgDim: '#616e88', fgSoft: '#aeb7c8', accent: '#88c0d0',
    red: '#bf616a', yellow: '#ebcb8b', orange: '#d08770', green: '#a3be8c', cyan: '#8fbcbb', blue: '#81a1c1', magenta: '#b48ead',
  }),
  make('tokyo-night', 'Tokyo Night', 'dark', {
    bg: '#1a1b26', bgDark: '#16161e', bgLight: '#24283b', sel: '#33467c', muted: '#414868',
    fg: '#c0caf5', fgDim: '#565f89', fgSoft: '#a9b1d6', accent: '#7aa2f7',
    red: '#f7768e', yellow: '#e0af68', orange: '#ff9e64', green: '#9ece6a', cyan: '#7dcfff', blue: '#7aa2f7', magenta: '#bb9af7',
  }),
  make('rose-pine', 'Rosé Pine', 'dark', {
    bg: '#191724', bgDark: '#14121f', bgLight: '#1f1d2e', sel: '#2a283e', muted: '#403d52',
    fg: '#e0def4', fgDim: '#6e6a86', fgSoft: '#908caa', accent: '#c4a7e7',
    red: '#eb6f92', yellow: '#f6c177', orange: '#ebbcba', green: '#9ccfd8', cyan: '#31748f', blue: '#9ccfd8', magenta: '#c4a7e7',
  }),
]
/* artwork:end */

export function paletteById(id: string): PaletteDef | undefined {
  return PALETTES.find((p) => p.id === id)
}

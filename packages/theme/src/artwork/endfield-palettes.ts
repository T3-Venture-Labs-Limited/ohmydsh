// Endfield's paper/ink palettes (from dsh-theme-endfield's design language, MIT, see NOTICE), as Omarchy keys so the
// normal token generator serves them. Used by the Endfield look when the colour source is Stock.
import type { Colors, Mode } from '../shared/omarchy.ts'

interface Def { mode: Mode; colors: Colors }

function make(mode: Mode, p: {
  bg: string; bgDark: string; bgLight: string; sel: string; muted: string
  fg: string; fgDim: string; fgSoft: string; accent: string
  red: string; yellow: string; orange: string; green: string; cyan: string; blue: string; magenta: string
}): Def {
  return {
    mode,
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
export const ENDFIELD_DARK: Def = make('dark', {
  bg: '#101110', bgDark: '#101110', bgLight: '#181a18', sel: '#2c2e2a', muted: '#4a4d49',
  fg: '#f5f5f0', fgDim: '#70736f', fgSoft: '#a4a6a1', accent: '#fff500',
  red: '#ff6b61', yellow: '#ffb700', orange: '#d9822b', green: '#4fbf5c', cyan: '#14d0d0', blue: '#7aaaff', magenta: '#d58cff',
})

export const ENDFIELD_LIGHT: Def = make('light', {
  bg: '#e8e8e2', bgDark: '#e8e8e2', bgLight: '#f2f2ec', sel: '#dcddd6', muted: '#b6b8b3',
  fg: '#101110', fgDim: '#757874', fgSoft: '#4a4c48', accent: '#fff500',
  red: '#ff3b30', yellow: '#d9822b', orange: '#d9822b', green: '#2f9e44', cyan: '#006a6a', blue: '#4176e6', magenta: '#9b4dca',
})
/* artwork:end */

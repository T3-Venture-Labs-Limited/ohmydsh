// English dictionary: the typed source of truth for every UI string. `{name}` placeholders are filled from params.
// Import the helper directly (not the kit barrel): the entry must not pull kit components onto the boot path.
import { defineLocale } from '../kit/locale.ts'

export const locale = defineLocale('dsh-theme', {
  nav: 'Theme',
  pageTitle: 'Theme',
  pageDescription: 'Colour DSH from your Omarchy theme or a bundled palette. Switching back to Stock removes every override.',
  panelLoading: 'Loading…',
  sectionSource: 'Colours',
  sourceTitle: 'Colour source',
  sourceDescription: 'Stock keeps DSH’s own look. Follow Omarchy tracks your desktop theme live.',
  sourceLabel: 'Colour source',
  sourceStock: 'Stock',
  sourceOmarchy: 'Follow Omarchy',
  sourcePalette: 'Palette',
  paletteTitle: 'Palette',
  paletteDescription: 'Bundled community palettes, generated from about 20 colours each.',
  paletteLabel: 'Palette',
  paletteDark: '{name} (dark)',
  paletteLight: '{name} (light)',
  statusTitle: 'Omarchy theme',
  statusLive: '{name} · {mode}',
  statusConnecting: 'Connecting…',
  statusUnavailable: 'Omarchy theme not found on this machine.',
  statusModeLight: 'light',
  statusModeDark: 'dark',
  pausedTitle: 'Following paused',
  pausedDescription: 'You changed Appearance, so DSH stopped following. Choose Follow Omarchy to resume.',
  sectionOptions: 'Options',
  semanticTitle: 'Use Omarchy status colours',
  semanticDescription: 'Off keeps DSH’s own red, amber and green for errors, warnings and success. Some Omarchy themes use these keys for other hues.',
  semanticLabel: 'Use Omarchy status colours',
  previewLabel: 'Colours currently applied',
})

export type T = ReturnType<typeof locale.bind>

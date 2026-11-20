// English dictionary: the typed source of truth for every UI string. `{name}` placeholders are filled from params.
// Import the helper directly (not the kit barrel): the entry must not pull kit components onto the boot path.
import { defineLocale } from '../kit/locale.ts'

export const locale = defineLocale('dsh-theme', {
  nav: 'Theme',
  pageTitle: 'Theme',
  pageDescription: 'Colour ohmydsh from your Omarchy theme or a bundled palette. Switching back to Stock removes every override.',
  panelLoading: 'Loading…',
  sectionSource: 'Colours',
  sourceTitle: 'Colour source',
  sourceDescription: 'Stock keeps ohmydsh’s own look and follows this device’s light or dark mode. Follow Omarchy tracks your desktop theme live and is meant for the computer that runs Omarchy.',
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
  schemeTitle: 'Appearance differs from the palette',
  schemeHintDark: 'This palette is dark. Set Appearance to System, or to Dark, to match your Omarchy theme.',
  schemeHintLight: 'This palette is light. Set Appearance to System, or to Light, to match your Omarchy theme.',
  sectionOptions: 'Options',
  semanticTitle: 'Use Omarchy status colours',
  semanticDescription: 'Off keeps ohmydsh’s own red, amber and green for errors, warnings and success. Some Omarchy themes use these keys for other hues.',
  semanticLabel: 'Use Omarchy status colours',
  endfieldTitle: 'dsh-theme-endfield detected',
  endfieldDescription: 'Its square corners stay. Its colours and accent follow the palette above instead of its own yellow or cyan.',
  previewLabel: 'Colours currently applied',
})

export type T = ReturnType<typeof locale.bind>

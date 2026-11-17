// English dictionary: the typed source of truth for every UI string. `{name}` placeholders are filled from params.
// Import the helper directly (not the kit barrel): the entry must not pull kit components onto the boot path.
import { defineLocale } from '../kit/locale.ts'

export const locale = defineLocale('__PKG__', {
  nav: '__TITLE__',
  panel: '__TITLE__',
  pageTitle: '__TITLE__',
  pageDescription: 'Demo page built from the dsh-kit controls. Replace it with your settings.',
  sectionGeneral: 'General',
  enabledTitle: 'Enable feature',
  enabledDescription: 'A switch (role=switch) with a required accessible label.',
  modeTitle: 'Mode',
  modeDescription: 'Segmented control with arrow-key navigation.',
  modeCompact: 'Compact',
  modeComfortable: 'Comfortable',
  modeSpacious: 'Spacious',
  modeLabel: 'Display mode',
  modelTitle: 'Model',
  modelLabel: 'Model',
  nameLabel: 'Display name',
  nameHint: 'Shown in the sidebar.',
  nameError: 'Use at least 3 characters.',
  sectionActions: 'Actions',
  resetTitle: 'Reset to defaults',
  resetDescription: 'Opens a confirmation dialog (focus trap, Escape to close).',
  resetButton: 'Reset…',
  confirmTitle: 'Reset settings?',
  confirmDescription: 'This restores every control on this page to its default value.',
  confirmAction: 'Reset',
  cancel: 'Cancel',
  close: 'Close',
  help: 'Show help',
  helpTooltip: 'Tooltips appear on hover and keyboard focus.',
  panelEmptyTitle: 'Nothing here yet',
  panelEmptyDescription: 'This sidebar panel is a demo. Add your own content in src/client/panel.tsx.',
  panelLoading: 'Loading…',
  panelAction: 'Open settings',
})

export type T = ReturnType<typeof locale.bind>

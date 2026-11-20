// English dictionary: the typed source of truth for every UI string.
// Import the helper directly (not the kit barrel): the entry must not pull kit components onto the boot path.
import { defineLocale } from '../kit/locale.ts'

export const locale = defineLocale('ohmydsh-brand', {
  productName: 'ohmydsh',
  builtOnTooltip: 'ohmydsh, built on DeepSeek Harness',
  builtOn: 'Built on',
  harnessName: 'DeepSeek Harness',
  disclaimer: 'ohmydsh is an independent distribution. DeepSeek did not make it and does not endorse or support it.',
})

export type T = ReturnType<typeof locale.bind>

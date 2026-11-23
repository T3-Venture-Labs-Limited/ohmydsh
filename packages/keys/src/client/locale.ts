// English dictionary: the typed source of truth for every UI string.
// Import the helper directly (not the kit barrel): the entry must not pull kit components onto the boot path.
import { defineLocale } from '../kit/locale.ts'

export const locale = defineLocale('ohmydsh-keys', {
  focusLabel: 'Answer the waiting approval or question with the keyboard',
  hintApproval: '1–{max} choose · Enter allow once · Esc reject',
  hintQuestionSingle: '1–{max} choose · ↑↓ move · Enter confirm · Tab type an answer',
  hintQuestionMulti: '1–{max} toggle · ↑↓ move · Enter confirm · Tab type an answer',
  hintQuestionPager: ' · ←→ questions · Ctrl+Backspace skip',
  hintPending: '{keys} to answer with the keyboard',
  rowApprovalChoose: 'Approval: allow once, always allow, reject',
  rowQuestionChoose: 'Question: pick or toggle an option',
  rowQuestionMove: 'Question: move between options',
  rowQuestionPager: 'Question: previous and next question',
  rowQuestionSkip: 'Question: skip',
  rowQuestionOther: 'Question: type your own answer',
})

export type T = ReturnType<typeof locale.bind>

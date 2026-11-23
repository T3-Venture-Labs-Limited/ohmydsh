// The key map as pure functions: a key press plus a small description of the card -> the action to run (or null: leave the
// key alone). No DOM here; controller.ts executes the action by clicking DSH's own controls.
//
//   Approval          1 allow once · 2 always allow (when offered, else reject) · 3 reject · Esc reject · Enter allow once
//                     (Enter never grants "always"; Enter on a focused button presses that button, as the browser does)
//   Question          1-9 pick/toggle · Up/Down move · Enter confirm / next · Tab custom answer · Left/Right previous/next
//                     question · Ctrl+Backspace skip. Space on a focused option toggles it natively (it is a <button>).
//   In the custom answer field only Esc is ours (back to the options); every other key types or behaves as usual.

export interface KeyInput {
  readonly key: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift: boolean
}

export type Focus = 'option' | 'editable' | 'button' | 'other'

export type ApprovalAction = 'allow' | 'always' | 'reject'

export interface ApprovalState {
  readonly hasAlways: boolean
  readonly focus: Focus
}

const DIGIT = /^[1-9]$/

/** A plain key: no Ctrl/Meta/Alt (Shift is allowed only where a layout needs it to type a digit). */
const bare = (k: KeyInput): boolean => !k.ctrl && !k.meta && !k.alt

export function approvalAction(k: KeyInput, state: ApprovalState): ApprovalAction | null {
  if (state.focus === 'editable' || !bare(k)) return null
  if (DIGIT.test(k.key)) {
    if (k.key === '1') return 'allow'
    if (k.key === '2') return state.hasAlways ? 'always' : 'reject'
    if (k.key === '3') return 'reject'
    return null
  }
  if (k.shift) return null
  if (k.key === 'Escape') return 'reject'
  if (k.key === 'Enter') return state.focus === 'button' ? null : 'allow'
  return null
}

export interface QuestionState {
  readonly optionCount: number
  readonly hasTextarea: boolean
  readonly focus: Focus
}

export type QuestionAction =
  | { readonly type: 'option'; readonly index: number }
  | { readonly type: 'move'; readonly delta: 1 | -1 }
  | { readonly type: 'confirm' }
  | { readonly type: 'prev' }
  | { readonly type: 'next' }
  | { readonly type: 'skip' }
  | { readonly type: 'other' }
  | { readonly type: 'leaveOther' }

export function questionAction(k: KeyInput, state: QuestionState): QuestionAction | null {
  if (state.focus === 'editable') {
    // Only Escape: back to the options. Everything else belongs to the text field (digits, Enter, Ctrl+Backspace...).
    return k.key === 'Escape' && bare(k) && !k.shift && state.optionCount > 0 ? { type: 'leaveOther' } : null
  }
  if (k.ctrl && !k.meta && !k.alt && !k.shift && k.key === 'Backspace') return { type: 'skip' }
  if (!bare(k)) return null
  if (DIGIT.test(k.key)) {
    const index = Number(k.key) - 1
    return index < state.optionCount ? { type: 'option', index } : null
  }
  if (k.shift) return null
  switch (k.key) {
    case 'ArrowDown': return state.optionCount > 0 ? { type: 'move', delta: 1 } : null
    case 'ArrowUp': return state.optionCount > 0 ? { type: 'move', delta: -1 } : null
    case 'ArrowLeft': return { type: 'prev' }
    case 'ArrowRight': return { type: 'next' }
    case 'Enter': return state.focus === 'button' ? null : { type: 'confirm' }
    case 'Tab': return state.hasTextarea && (state.focus === 'option' || state.focus === 'other') ? { type: 'other' } : null
    default: return null
  }
}

/** Keys the controller swallows while they auto-repeat, so a held key never reaches whatever takes the focus next. */
export function isChordKey(k: KeyInput): boolean {
  return k.key === 'Enter' || k.key === 'Escape' || DIGIT.test(k.key) || k.key.startsWith('Arrow') || k.key === 'Tab' || k.key === 'Backspace'
}

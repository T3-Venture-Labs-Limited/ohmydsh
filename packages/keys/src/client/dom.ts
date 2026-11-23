// The DOM bridge. DSH renders both cards from its own React components and offers no slot or event for keyboard answers,
// so this file is the ONE place that knows the stock markup. tests/selector-guard.spec.ts reads the installed DSH
// sources/bundle and fails loudly when any fact below changes, so a DSH update cannot quietly break the keys.
//
// What we rely on (DSH 0.2.2-rc.x):
//   approval card   root `[data-approval-key]` > card > (strip, body `[data-approval-scroll]` tabIndex 0, actionRow).
//                   actionRow children, in order: Reject, Allow once, and (only when offered) Always allow.
//                   `aria-busy="true"` on the root once an answer was sent.
//   question card   root `[data-question-key]` > section > (header, `[data-question-scroll]` body, footer).
//                   options: `[data-option-row] button[role=radio|checkbox][aria-checked]`, a custom-answer <textarea>;
//                   footer: first <div> = pager (previous, "i / n", next), last <div> = actions (Skip, Next/Submit).
// Every action is a click on DSH's own control, so DSH's locks, scopes and request identity stay in charge.

export const SEL = {
  approval: '[data-approval-key]',
  approvalBody: '[data-approval-scroll]',
  question: '[data-question-key]',
  questionBody: '[data-question-scroll]',
  option: '[data-option-row] [role="radio"], [data-option-row] [role="checkbox"]',
  editable: 'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
} as const
/** Either card. */
export const CARD_SELECTOR = `${SEL.approval}, ${SEL.question}`

export type CardKind = 'approval' | 'question'

export function kindOf(card: Element): CardKind {
  return card.matches(SEL.approval) ? 'approval' : 'question'
}

/** The nearest card around `node`, or null. */
export function cardOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null
  return el === null ? null : el.closest<HTMLElement>(CARD_SELECTOR)
}

export function isEditable(node: Element | null): boolean {
  return node !== null && node.closest(SEL.editable) !== null
}

export interface ApprovalParts {
  readonly reject: HTMLButtonElement
  readonly allow: HTMLButtonElement
  /** Present only when the request offers a persistent grant. */
  readonly always: HTMLButtonElement | undefined
}

/** The three buttons by position (Reject, Allow once, Always allow), independent of language. Null when the layout is unknown. */
export function approvalParts(card: Element): ApprovalParts | null {
  const row = card.querySelector(SEL.approvalBody)?.nextElementSibling ?? null
  if (row === null) return null
  const buttons = Array.from(row.children).filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement)
  if (buttons.length < 2 || buttons.length > 3) return null
  return { reject: buttons[0] as HTMLButtonElement, allow: buttons[1] as HTMLButtonElement, always: buttons[2] }
}

export function approvalBusy(card: Element): boolean {
  return card.getAttribute('aria-busy') === 'true'
}

export interface QuestionParts {
  readonly options: readonly HTMLButtonElement[]
  /** Checkbox options (multi-select) rather than radio. */
  readonly multi: boolean
  /** The custom-answer field. */
  readonly textarea: HTMLTextAreaElement | null
  readonly prev: HTMLButtonElement | null
  readonly next: HTMLButtonElement | null
  readonly skip: HTMLButtonElement | null
  /** Next / Submit. */
  readonly primary: HTMLButtonElement | null
  /** Number of questions in this batch (1 when there is no pager text). */
  readonly total: number
  /** A read-only card (a recorded answer) or a card whose controls are frozen by a submission in flight. */
  readonly locked: boolean
}

function directButtons(parent: Element | null | undefined): HTMLButtonElement[] {
  if (parent === null || parent === undefined) return []
  return Array.from(parent.children).filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement)
}

export function questionParts(card: Element): QuestionParts {
  const options = Array.from(card.querySelectorAll<HTMLButtonElement>(SEL.option))
  const footer = card.querySelector('footer')
  const divs = footer === null ? [] : Array.from(footer.children).filter((el) => el.tagName === 'DIV')
  const pager = divs[0] ?? null
  const actions = divs.length > 1 ? (divs[divs.length - 1] as Element) : null
  const pagerButtons = directButtons(pager)
  const actionButtons = directButtons(actions)
  const total = Number(/\/\s*(\d+)/.exec(pager?.textContent ?? '')?.[1] ?? 1)
  const multi = options[0]?.getAttribute('role') === 'checkbox'
  return {
    options,
    multi,
    textarea: card.querySelector('textarea'),
    prev: pagerButtons.length === 2 ? (pagerButtons[0] as HTMLButtonElement) : null,
    next: pagerButtons.length === 2 ? (pagerButtons[1] as HTMLButtonElement) : null,
    skip: actionButtons.length === 2 ? (actionButtons[0] as HTMLButtonElement) : null,
    primary: actionButtons.length === 2 ? (actionButtons[1] as HTMLButtonElement) : null,
    total: Number.isFinite(total) && total > 0 ? total : 1,
    locked: options.length > 0 && options.every((o) => o.disabled),
  }
}

/** Where the focus is, relative to one card. */
export type FocusKind = 'option' | 'editable' | 'button' | 'other'

export function focusKind(card: Element, active: Element | null, options: readonly Element[]): FocusKind | null {
  if (active === null || !card.contains(active)) return null
  if (isEditable(active)) return 'editable'
  if (options.includes(active)) return 'option'
  if (active.closest('button, a[href], [role="button"]') !== null) return 'button'
  return 'other'
}

/** Visible to the user: connected, not hidden by an ancestor, and laid out. */
export function isShown(el: Element): boolean {
  if (!el.isConnected) return false
  if (el.closest('[hidden], [inert], [aria-hidden="true"]') !== null) return false
  if (el.getClientRects().length === 0) return false
  const view = el.ownerDocument.defaultView
  if (view === null) return true
  const style = view.getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

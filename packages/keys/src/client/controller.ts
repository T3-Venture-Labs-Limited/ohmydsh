// Keyboard answers for DSH's approval and question cards.
//
// How it works: one capture-phase keydown listener on the document. A key that lands inside a card (focus is in the card:
// either it was moved there when the card appeared, or the user pressed the "focus" shortcut) is mapped by keymap.ts and
// executed by CLICKING DSH's own buttons (dom.ts), so DSH's locks, scopes and request identity stay in charge. A card is
// only touched while it is connected, visible and not already answering. Cards get their hints and number badges as
// attributes (data-ohmydsh-key*, aria-keyshortcuts) that styles.ts paints with pseudo-elements: no foreign nodes are
// inserted into DSH's React tree.
import { SEL, CARD_SELECTOR, approvalBusy, approvalParts, cardOf, focusKind, isEditable, isShown, kindOf, questionParts } from './dom.ts'
import type { FocusKind } from './dom.ts'
import { approvalAction, isChordKey, questionAction } from './keymap.ts'
import type { KeyInput } from './keymap.ts'
import type { KeysConfig } from '../shared/config.ts'

type Translate = (key: never, params?: Record<string, string | number>) => string

export interface ControllerDeps {
  readonly doc: Document
  readonly config: KeysConfig
  /** Typed `t` of the locale dictionary. */
  readonly t: Translate
  readonly now?: () => number
  /** Display text of the "focus the waiting card" shortcut ("Ctrl+Alt+J"), or undefined when it is unbound. */
  readonly focusKeys?: () => string | undefined
  /** Defer work to after DSH's render (requestAnimationFrame in the page). */
  readonly later?: (fn: () => void) => void
  readonly shown?: (el: Element) => boolean
}

export interface Controller {
  /** Install the listeners and scan for cards already on the page. Returns the disposer. */
  start(): () => void
  /** Re-decorate every card (the shortcut label or the configuration changed). */
  refresh(): void
  /** Focus the waiting card nearest to `from` (the pane you are in). False when no card is waiting here. */
  focusWaiting(from: Element | null): boolean
}

/** A keystroke in a text field this recently means the user is typing: never take the focus away. */
export const TYPING_WINDOW_MS = 1500
const BLUR_WINDOW_MS = 400
/** How long a handled key keeps swallowing its own auto-repeat. */
const HELD_MS = 5000

interface Tracked {
  readonly card: HTMLElement
  readonly observer: MutationObserver
  readonly appearedAt: number
  /** Whether the appearance rule (auto-focus or hint) has run. It runs once, when the card is first visible. */
  handled: boolean
  /** The card is waiting and the keys are not live yet (focus was not taken): the hint says how to start. */
  pending: boolean
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'OS'])

function textOf(el: Element | null): string {
  if (el === null) return ''
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim()
  return (el.textContent ?? '').trim()
}

function toInput(e: KeyboardEvent): KeyInput {
  return { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey }
}

function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) { if (el.hasAttribute(name)) el.removeAttribute(name); return }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

function depth(el: Element): number {
  let n = 0
  for (let p = el.parentElement; p !== null; p = p.parentElement) n++
  return n
}

/** Depth of the deepest ancestor shared by both elements (-1 when they are in different trees). */
function sharedDepth(a: Element, b: Element): number {
  const mine = new Set<Element>()
  for (let p: Element | null = a; p !== null; p = p.parentElement) mine.add(p)
  for (let p: Element | null = b; p !== null; p = p.parentElement) if (mine.has(p)) return depth(p)
  return -1
}

export function createController(deps: ControllerDeps): Controller {
  const { doc, config, t } = deps
  const tr = t as unknown as (key: string, params?: Record<string, string | number>) => string
  const now = deps.now ?? (() => Date.now())
  const later = deps.later ?? ((fn: () => void) => { (doc.defaultView ?? globalThis).requestAnimationFrame(() => { fn() }) })
  const shown = deps.shown ?? isShown
  const tracked = new Map<Element, Tracked>()
  const held = new Map<string, number>()
  const typing = { keyAt: -Infinity, blurAt: -Infinity, blurHadText: false }
  let composing = false
  let justComposed = false
  let pendingScan = false

  const live = (): Tracked[] => [...tracked.values()].filter((x) => x.card.isConnected && shown(x.card))

  // ---- decoration: hints, number badges, aria-keyshortcuts --------------------------------------------------------

  function clearCard(card: Element): void {
    for (const name of ['data-ohmydsh-keys', 'data-ohmydsh-keys-hint']) card.removeAttribute(name)
    for (const el of card.querySelectorAll('[data-ohmydsh-key], [data-ohmydsh-key-end], [data-ohmydsh-keyshortcuts]')) {
      for (const name of ['data-ohmydsh-key', 'data-ohmydsh-key-end', 'data-ohmydsh-keyshortcuts']) el.removeAttribute(name)
      el.removeAttribute('aria-keyshortcuts')
    }
  }

  function mark(el: Element, shortcuts: string, badge?: string, end = false): void {
    setAttr(el, 'aria-keyshortcuts', shortcuts)
    setAttr(el, 'data-ohmydsh-keyshortcuts', '')
    setAttr(el, 'data-ohmydsh-key', badge !== undefined && !end ? badge : null)
    setAttr(el, 'data-ohmydsh-key-end', badge !== undefined && end ? badge : null)
  }

  function decorate(entry: Tracked): void {
    const card = entry.card
    const kind = kindOf(card)
    const pendingHint = entry.pending ? tr('hintPending', { keys: deps.focusKeys?.() ?? '' }).trim() : undefined
    const usePending = entry.pending && deps.focusKeys?.() !== undefined && pendingHint !== undefined
    if (kind === 'approval') {
      const parts = approvalParts(card)
      if (parts === null || approvalBusy(card)) { clearCard(card); return }
      setAttr(card, 'data-ohmydsh-keys', 'approval')
      const max = parts.always === undefined ? 2 : 3
      mark(parts.allow, '1 Enter', '1')
      if (parts.always !== undefined) {
        mark(parts.always, '2', '2')
        mark(parts.reject, '3 Escape', '3')
      } else mark(parts.reject, '2 3 Escape', '2')
      setAttr(card, 'data-ohmydsh-keys-hint', usePending ? pendingHint : tr('hintApproval', { max }))
      return
    }
    const q = questionParts(card)
    if (q.locked || q.options.length === 0) { clearCard(card); return }
    setAttr(card, 'data-ohmydsh-keys', 'question')
    q.options.forEach((option, i) => {
      if (i < 9) mark(option, String(i + 1), q.multi ? String(i + 1) : undefined, true)
      else option.removeAttribute('aria-keyshortcuts')
    })
    if (q.prev !== null) mark(q.prev, 'ArrowLeft')
    if (q.next !== null) mark(q.next, 'ArrowRight')
    if (q.skip !== null) mark(q.skip, 'Control+Backspace')
    if (q.primary !== null) mark(q.primary, 'Enter')
    const base = tr(q.multi ? 'hintQuestionMulti' : 'hintQuestionSingle', { max: Math.min(q.options.length, 9) })
    setAttr(card, 'data-ohmydsh-keys-hint', usePending ? pendingHint : base + (q.total > 1 ? tr('hintQuestionPager') : ''))
  }

  // ---- focus ------------------------------------------------------------------------------------------------------

  function focusTarget(card: HTMLElement): HTMLElement | null {
    if (kindOf(card) === 'approval') {
      return card.querySelector<HTMLElement>(SEL.approvalBody) ?? approvalParts(card)?.allow ?? null
    }
    const q = questionParts(card)
    const selected = q.options.find((o) => o.getAttribute('aria-checked') === 'true' && !o.disabled)
    return selected ?? q.options.find((o) => !o.disabled) ?? q.textarea ?? q.primary
  }

  function focusCard(card: HTMLElement): boolean {
    const target = focusTarget(card)
    if (target === null) return false
    target.focus()
    const entry = tracked.get(card)
    if (entry !== undefined && entry.pending) { entry.pending = false; decorate(entry) }
    return doc.activeElement === target
  }

  /** After DSH re-rendered (the option that had focus can be gone), put the focus back into the card, once. */
  function keepFocus(card: HTMLElement): void {
    const check = (): void => {
      if (!card.isConnected) return
      const active = doc.activeElement
      if (active !== null && active !== doc.body) return
      focusCard(card)
    }
    later(check)
    later(() => { later(check) })
  }

  function typingNow(): boolean {
    const n = now()
    if (n - typing.keyAt < TYPING_WINDOW_MS) return true
    if (n - typing.blurAt < BLUR_WINDOW_MS && typing.blurHadText) return true
    const active = doc.activeElement
    return active !== null && isEditable(active) && cardOf(active) === null && textOf(active) !== ''
  }

  function onAppear(entry: Tracked): void {
    entry.handled = true
    if (!config.autoFocus || typingNow() || !focusCard(entry.card)) entry.pending = true
    decorate(entry)
  }

  function pickCard(from: Element | null): HTMLElement | null {
    const cards = live()
    if (cards.length === 0) return null
    if (from !== null) {
      const inside = cards.find((x) => x.card.contains(from))
      if (inside !== undefined) return inside.card
    }
    let best: Tracked | undefined
    let bestScore = -2
    for (const x of cards) {
      const score = from === null ? -1 : sharedDepth(x.card, from)
      if (best === undefined || score > bestScore || (score === bestScore && x.appearedAt >= best.appearedAt)) { best = x; bestScore = score }
    }
    return best?.card ?? null
  }

  // ---- scanning ---------------------------------------------------------------------------------------------------

  function track(card: HTMLElement): void {
    const observer = new MutationObserver(() => { later(() => { const e = tracked.get(card); if (e !== undefined && card.isConnected) decorate(e) }) })
    observer.observe(card, { childList: true, subtree: true })
    tracked.set(card, { card, observer, appearedAt: now(), handled: false, pending: false })
  }

  function untrack(card: Element): void {
    tracked.get(card)?.observer.disconnect()
    tracked.delete(card)
  }

  function scan(): void {
    pendingScan = false
    const found = new Set(doc.querySelectorAll<HTMLElement>(CARD_SELECTOR))
    for (const card of tracked.keys()) if (!found.has(card as HTMLElement) || !card.isConnected) untrack(card)
    for (const card of found) if (!tracked.has(card)) track(card)
    for (const entry of tracked.values()) {
      if (!entry.handled && shown(entry.card)) onAppear(entry)
      else decorate(entry)
    }
  }

  function scheduleScan(): void {
    if (pendingScan) return
    pendingScan = true
    later(scan)
  }

  const mayContainCard = (node: Node): boolean =>
    node.nodeType === 1 && ((node as Element).matches(CARD_SELECTOR) || (node as Element).querySelector(CARD_SELECTOR) !== null)

  // ---- keyboard ---------------------------------------------------------------------------------------------------

  function swallow(e: Event): void {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  }

  function clickable(btn: HTMLButtonElement | null | undefined): btn is HTMLButtonElement {
    return btn !== null && btn !== undefined && btn.isConnected && !btn.disabled
  }

  function runApproval(card: HTMLElement, e: KeyboardEvent): boolean {
    const parts = approvalParts(card)
    if (parts === null || approvalBusy(card)) return false
    const focus = focusKind(card, doc.activeElement, []) ?? 'other'
    const action = approvalAction(toInput(e), { hasAlways: parts.always !== undefined, focus })
    if (action === null) return false
    swallow(e)
    if (e.repeat) return true
    const button = action === 'allow' ? parts.allow : action === 'always' ? parts.always : parts.reject
    if (clickable(button)) button.click()
    return true
  }

  function runQuestion(card: HTMLElement, e: KeyboardEvent): boolean {
    const q = questionParts(card)
    if (q.locked || (q.options.length === 0 && q.textarea === null)) return false
    const active = doc.activeElement
    const focus: FocusKind = focusKind(card, active, q.options) ?? 'other'
    const enabled = q.options.filter((o) => !o.disabled)
    const action = questionAction(toInput(e), { optionCount: q.options.length, hasTextarea: q.textarea !== null, focus })
    if (action === null) return false
    swallow(e)
    if (e.repeat) return true
    switch (action.type) {
      case 'option': {
        const option = q.options[action.index]
        if (clickable(option)) { option.focus(); option.click(); keepFocus(card) }
        break
      }
      case 'move': {
        if (enabled.length === 0) break
        const at = active instanceof HTMLButtonElement ? enabled.indexOf(active) : -1
        const to = at < 0 ? (action.delta > 0 ? 0 : enabled.length - 1) : (at + action.delta + enabled.length) % enabled.length
        enabled[to]?.focus()
        break
      }
      case 'confirm': {
        const at = active instanceof HTMLButtonElement ? q.options.indexOf(active) : -1
        const last = q.next === null || q.next.disabled
        const option = at >= 0 ? q.options[at] : undefined
        if (!q.multi && option !== undefined && option.getAttribute('aria-checked') !== 'true' && clickable(option)) {
          // A focused option that is not chosen yet: choose it (a single-select choice moves to the next question by
          // itself); on the last question also send, once DSH has re-rendered.
          option.click()
          if (last) later(() => { later(() => { const p = questionParts(card).primary; if (clickable(p)) p.click() }) })
          keepFocus(card)
        } else if (clickable(q.primary)) { q.primary.click(); keepFocus(card) }
        break
      }
      case 'prev': if (clickable(q.prev)) { q.prev.click(); keepFocus(card) } break
      case 'next': if (clickable(q.next)) { q.next.click(); keepFocus(card) } break
      case 'skip': if (clickable(q.skip)) { q.skip.click(); keepFocus(card) } break
      case 'other': if (q.textarea !== null && !q.textarea.disabled) { q.textarea.focus(); const n = q.textarea.value.length; q.textarea.setSelectionRange(n, n) } break
      case 'leaveOther': {
        const target = q.options.find((o) => o.getAttribute('aria-checked') === 'true' && !o.disabled) ?? enabled[0]
        target?.focus()
        break
      }
    }
    return true
  }

  function onKeydown(e: KeyboardEvent): void {
    // A key we handled keeps its auto-repeat from reaching whatever has the focus once the card is gone (a held Enter
    // must never press Send in the composer).
    if (e.repeat && held.has(e.code)) { swallow(e); return }
    if (e.defaultPrevented) return
    const target = e.target instanceof Element ? e.target : null
    const card = cardOf(target)
    if (card === null) {
      if (target !== null && isEditable(target) && !MODIFIER_KEYS.has(e.key)) { typing.keyAt = now(); typing.blurHadText = textOf(target) !== '' }
      return
    }
    if (!config.enabled) return
    if (composing || justComposed || e.isComposing || e.keyCode === 229) return
    const entry = tracked.get(card)
    if (entry === undefined || !shown(card)) return
    const handled = kindOf(card) === 'approval' ? runApproval(card, e) : runQuestion(card, e)
    if (handled && isChordKey(toInput(e))) {
      held.set(e.code, now())
      for (const [code, at] of held) if (now() - at > HELD_MS) held.delete(code)
    }
  }

  const onKeyup = (e: KeyboardEvent): void => { held.delete(e.code); justComposed = false }
  const onCompositionStart = (): void => { composing = true }
  const onCompositionEnd = (): void => { composing = false; justComposed = true }
  const onFocusin = (e: FocusEvent): void => {
    const card = cardOf(e.target instanceof Node ? e.target : null)
    if (card === null) { scheduleScan(); return }
    const entry = tracked.get(card)
    if (entry !== undefined && entry.pending) { entry.pending = false; decorate(entry) }
  }
  const onFocusout = (e: FocusEvent): void => {
    const target = e.target instanceof Element ? e.target : null
    if (target !== null && isEditable(target) && cardOf(target) === null) { typing.blurAt = now(); typing.blurHadText = textOf(target) !== '' }
  }

  return {
    start() {
      const view = doc.defaultView
      const observer = new MutationObserver((records) => {
        let relevant = false
        for (const r of records) {
          if (tracked.size > 0 && r.removedNodes.length > 0) { relevant = true; break }
          for (const node of r.addedNodes) if (mayContainCard(node)) { relevant = true; break }
          if (relevant) break
        }
        if (relevant) scheduleScan()
      })
      observer.observe(doc.body, { childList: true, subtree: true })
      doc.addEventListener('keydown', onKeydown, true)
      doc.addEventListener('keyup', onKeyup, true)
      doc.addEventListener('compositionstart', onCompositionStart, true)
      doc.addEventListener('compositionend', onCompositionEnd, true)
      doc.addEventListener('focusin', onFocusin, true)
      doc.addEventListener('focusout', onFocusout, true)
      doc.addEventListener('visibilitychange', scheduleScan)
      view?.addEventListener('focus', scheduleScan)
      scan()
      return () => {
        observer.disconnect()
        doc.removeEventListener('keydown', onKeydown, true)
        doc.removeEventListener('keyup', onKeyup, true)
        doc.removeEventListener('compositionstart', onCompositionStart, true)
        doc.removeEventListener('compositionend', onCompositionEnd, true)
        doc.removeEventListener('focusin', onFocusin, true)
        doc.removeEventListener('focusout', onFocusout, true)
        doc.removeEventListener('visibilitychange', scheduleScan)
        view?.removeEventListener('focus', scheduleScan)
        for (const card of tracked.keys()) { clearCard(card); untrack(card) }
        held.clear()
      }
    },
    refresh() { for (const entry of tracked.values()) decorate(entry) },
    focusWaiting(from) {
      const card = pickCard(from)
      return card === null ? false : focusCard(card)
    },
  }
}

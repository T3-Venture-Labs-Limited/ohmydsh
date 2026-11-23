import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createController, TYPING_WINDOW_MS } from '../src/client/controller.ts'
import type { Controller } from '../src/client/controller.ts'
import { approvalCard, key, questionCard } from './fixtures.ts'

const t = (k: string, p?: Record<string, string | number>): string => {
  const table: Record<string, string> = {
    hintApproval: '1–{max} choose · Enter allow once · Esc reject',
    hintQuestionSingle: '1–{max} choose · ↑↓ move · Enter confirm · Tab type an answer',
    hintQuestionMulti: '1–{max} toggle · ↑↓ move · Enter confirm · Tab type an answer',
    hintQuestionPager: ' · ←→ questions · Ctrl+Backspace skip',
    hintPending: '{keys} to answer with the keyboard',
  }
  return (table[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(p?.[n] ?? ''))
}

let clock = 10_000
let controller: Controller | undefined
let stop: (() => void) | undefined
let hidden = new Set<Element>()

function boot(opts: { autoFocus?: boolean; keys?: string | undefined } = {}): void {
  controller = createController({
    doc: document,
    config: { enabled: true, autoFocus: opts.autoFocus ?? true },
    t: t as never,
    now: () => clock,
    focusKeys: () => ('keys' in opts ? opts.keys : 'Ctrl+Alt+J'),
    later: (fn) => { fn() },
    shown: (el) => el.isConnected && !hidden.has(el),
  })
  stop = controller.start()
}

const mount = (...els: Element[]): void => { document.body.append(...els) }
const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
const hint = (root: Element): string | null => root.getAttribute('data-ohmydsh-keys-hint')

beforeEach(() => { document.body.innerHTML = ''; clock = 10_000; hidden = new Set(); controller = undefined; stop = undefined })
afterEach(() => { stop?.(); document.body.innerHTML = '' })

describe('approval card', () => {
  it('1 allows once, 2 rejects without "always", 3 and Esc reject, Enter allows once', () => {
    for (const [k, expected] of [['1', 'Allow once'], ['2', 'Reject'], ['3', 'Reject'], ['Escape', 'Reject'], ['Enter', 'Allow once']] as const) {
      const a = approvalCard()
      mount(a.root)
      boot()
      const body = a.root.querySelector<HTMLElement>('[data-approval-scroll]')!
      body.focus()
      const e = key(body, k)
      expect(a.clicks, k).toEqual([expected])
      expect(e.defaultPrevented, k).toBe(true)
      stop?.()
      document.body.innerHTML = ''
    }
  })

  it('with "always": 1 allow once, 2 always allow, 3 reject; Enter is still allow once, never always', () => {
    const a = approvalCard({ always: true })
    mount(a.root)
    boot()
    const body = a.root.querySelector<HTMLElement>('[data-approval-scroll]')!
    body.focus()
    key(body, '1'); key(body, '2'); key(body, '3'); key(body, 'Enter')
    expect(a.clicks).toEqual(['Allow once', 'Always allow', 'Reject', 'Allow once'])
  })

  it('Enter on a focused button is left to the browser (that button\'s own press)', () => {
    const a = approvalCard({ always: true })
    mount(a.root)
    boot()
    a.buttons['reject']!.focus()
    const e = key(a.buttons['reject']!, 'Enter')
    expect(e.defaultPrevented).toBe(false)
    expect(a.clicks).toEqual([])
    // digits and Esc still work from a focused button
    key(a.buttons['reject']!, '1')
    expect(a.clicks).toEqual(['Allow once'])
  })

  it('ignores keys when the focus is not inside the card, and never touches them', () => {
    const a = approvalCard()
    const composer = document.createElement('div')
    composer.setAttribute('contenteditable', 'true')
    mount(a.root, composer)
    boot({ autoFocus: false })
    composer.focus()
    for (const k of ['1', '2', '3', 'Enter', 'Escape']) {
      const e = key(composer, k)
      expect(e.defaultPrevented, k).toBe(false)
    }
    expect(a.clicks).toEqual([])
  })

  it('ignores modified keys and Shift+Enter', () => {
    const a = approvalCard()
    mount(a.root)
    boot()
    const body = a.root.querySelector<HTMLElement>('[data-approval-scroll]')!
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) { key(body, '1', init); key(body, 'Enter', init); key(body, 'Escape', init) }
    key(body, 'Enter', { shiftKey: true })
    expect(a.clicks).toEqual([])
  })

  it('does nothing to a card that is already answering, or hidden, or whose buttons are disabled', () => {
    const busy = approvalCard({ busy: true, key: 'a' })
    const hid = approvalCard({ key: 'b' })
    const off = approvalCard({ key: 'c' })
    off.buttons['allow']!.disabled = true
    mount(busy.root, hid.root, off.root)
    hidden.add(hid.root)
    boot({ autoFocus: false })
    key(busy.root.querySelector('[data-approval-scroll]')!, '1')
    key(hid.root.querySelector('[data-approval-scroll]')!, '1')
    key(off.root.querySelector('[data-approval-scroll]')!, '1')
    expect(busy.clicks).toEqual([])
    expect(hid.clicks).toEqual([])
    expect(off.clicks).toEqual([])
  })

  it('an answered card (removed from the page) receives nothing', () => {
    const a = approvalCard()
    mount(a.root)
    boot()
    const body = a.root.querySelector<HTMLElement>('[data-approval-scroll]')!
    key(body, '1')
    expect(a.clicks).toEqual(['Allow once'])
    a.root.remove()
    const next = document.createElement('div')
    mount(next)
    const e = key(next, '1')
    expect(e.defaultPrevented).toBe(false)
    expect(a.clicks).toEqual(['Allow once'])
  })

  it('ignores key repeat, and swallows the repeat of a handled key until it is released', () => {
    const a = approvalCard()
    const composer = document.createElement('div')
    composer.setAttribute('contenteditable', 'true')
    mount(a.root, composer)
    boot()
    const body = a.root.querySelector<HTMLElement>('[data-approval-scroll]')!
    body.focus()
    key(body, 'Enter')
    expect(a.clicks).toEqual(['Allow once'])
    // the card is gone, focus lands in the composer, the held Enter keeps repeating: it must not reach the composer
    const repeat = key(composer, 'Enter', { repeat: true })
    expect(repeat.defaultPrevented).toBe(true)
    expect(a.clicks).toEqual(['Allow once'])
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
    expect(key(composer, 'Enter').defaultPrevented).toBe(false)
  })

  it('a repeating key inside the card never acts (it is swallowed); other repeating keys are left alone', () => {
    const a = approvalCard()
    mount(a.root)
    boot()
    const body = a.root.querySelector<HTMLElement>('[data-approval-scroll]')!
    expect(key(body, '1', { repeat: true }).defaultPrevented).toBe(true)
    expect(key(body, 'a', { repeat: true }).defaultPrevented).toBe(false)
    expect(a.clicks).toEqual([])
  })

  it('ignores IME composition (isComposing, keyCode 229, and the key right after compositionend)', () => {
    const a = approvalCard()
    mount(a.root)
    boot()
    const body = a.root.querySelector<HTMLElement>('[data-approval-scroll]')!
    expect(key(body, 'Enter', { isComposing: true }).defaultPrevented).toBe(false)
    expect(key(body, 'Enter', { keyCode: 229 }).defaultPrevented).toBe(false)
    document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    expect(key(body, 'Enter').defaultPrevented).toBe(false)
    document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    expect(key(body, 'Enter').defaultPrevented).toBe(false)
    expect(a.clicks).toEqual([])
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
    key(body, 'Enter')
    expect(a.clicks).toEqual(['Allow once'])
  })

  it('shows number badges, aria-keyshortcuts and the hint line; dispose removes them all', () => {
    const a = approvalCard({ always: true })
    mount(a.root)
    boot()
    expect(a.buttons['allow']!.getAttribute('data-ohmydsh-key')).toBe('1')
    expect(a.buttons['always']!.getAttribute('data-ohmydsh-key')).toBe('2')
    expect(a.buttons['reject']!.getAttribute('data-ohmydsh-key')).toBe('3')
    expect(a.buttons['allow']!.getAttribute('aria-keyshortcuts')).toBe('1 Enter')
    expect(a.buttons['reject']!.getAttribute('aria-keyshortcuts')).toBe('3 Escape')
    expect(hint(a.root)).toBe('1–3 choose · Enter allow once · Esc reject')
    stop?.(); stop = undefined
    expect(a.root.querySelectorAll('[data-ohmydsh-key], [aria-keyshortcuts], [data-ohmydsh-keys-hint]').length).toBe(0)
  })

  it('without "always" the reject button is number 2 and the hint says 1–2', () => {
    const a = approvalCard()
    mount(a.root)
    boot()
    expect(a.buttons['reject']!.getAttribute('data-ohmydsh-key')).toBe('2')
    expect(a.buttons['reject']!.getAttribute('aria-keyshortcuts')).toBe('2 3 Escape')
    expect(hint(a.root)).toBe('1–2 choose · Enter allow once · Esc reject')
  })
})

describe('focus rules', () => {
  const composer = (text = ''): HTMLElement => {
    const c = document.createElement('div')
    c.setAttribute('contenteditable', 'true')
    c.textContent = text
    return c
  }

  it('a new card takes the focus when you are not typing', async () => {
    boot()
    const a = approvalCard()
    mount(a.root)
    await tick()
    expect(document.activeElement).toBe(a.root.querySelector('[data-approval-scroll]'))
    expect(hint(a.root)).toContain('Enter allow once')
  })

  it('does not take the focus right after a keystroke in a text field: it shows the hint instead; Ctrl+Alt+J then focuses it', async () => {
    const c = composer()
    mount(c)
    boot()
    c.focus()
    key(c, 'a')
    clock += 300
    const a = approvalCard()
    mount(a.root)
    await tick()
    expect(document.activeElement).toBe(c)
    expect(hint(a.root)).toBe('Ctrl+Alt+J to answer with the keyboard')
    expect(controller!.focusWaiting(c)).toBe(true)
    expect(document.activeElement).toBe(a.root.querySelector('[data-approval-scroll]'))
    expect(hint(a.root)).toContain('Enter allow once')
  })

  it('a keystroke older than the typing window no longer blocks', async () => {
    const c = composer()
    mount(c)
    boot()
    c.focus()
    key(c, 'a')
    clock += TYPING_WINDOW_MS + 1
    const a = approvalCard()
    mount(a.root)
    await tick()
    expect(document.activeElement).toBe(a.root.querySelector('[data-approval-scroll]'))
  })

  it('a text field that holds text keeps the focus even when you paused', async () => {
    const c = composer('half a sentence')
    mount(c)
    boot()
    c.focus()
    clock += 60_000
    const a = approvalCard()
    mount(a.root)
    await tick()
    expect(document.activeElement).toBe(c)
    expect(hint(a.root)).toContain('Ctrl+Alt+J')
  })

  it('an empty text field does not block', async () => {
    const c = composer()
    mount(c)
    boot()
    c.focus()
    clock += 60_000
    const a = approvalCard()
    mount(a.root)
    await tick()
    expect(document.activeElement).toBe(a.root.querySelector('[data-approval-scroll]'))
  })

  it('the field that lost focus just before the card replaced it (composer takeover) still counts as typing', async () => {
    const c = composer('draft')
    mount(c)
    boot()
    c.focus()
    clock += 100
    c.blur()
    clock += 50
    const a = approvalCard()
    mount(a.root)
    await tick()
    expect(document.activeElement).not.toBe(a.root.querySelector('[data-approval-scroll]'))
  })

  it('autoFocus:false never takes the focus', async () => {
    boot({ autoFocus: false })
    const a = approvalCard()
    mount(a.root)
    await tick()
    expect(document.activeElement).toBe(document.body)
    expect(hint(a.root)).toContain('Ctrl+Alt+J')
  })

  it('with the shortcut unbound there is no hint about it and the normal hint stays', async () => {
    boot({ autoFocus: false, keys: undefined })
    const a = approvalCard()
    mount(a.root)
    await tick()
    expect(hint(a.root)).toContain('Enter allow once')
  })

  it('a card that is not visible yet is not focused until it is', async () => {
    boot()
    const a = approvalCard()
    hidden.add(a.root)
    mount(a.root)
    await tick()
    expect(document.activeElement).toBe(document.body)
    hidden.delete(a.root)
    controller!.refresh()
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()
    expect(document.activeElement).toBe(a.root.querySelector('[data-approval-scroll]'))
  })
})

describe('several cards', () => {
  it('Ctrl+Alt+J goes to the card in the pane you are in, never to a hidden one', () => {
    const paneA = document.createElement('section')
    const paneB = document.createElement('section')
    const inputA = document.createElement('input')
    const inputB = document.createElement('input')
    const a = approvalCard({ key: 'a' })
    const b = approvalCard({ key: 'b' })
    const c = approvalCard({ key: 'c' })
    paneA.append(inputA, a.root)
    paneB.append(inputB, b.root, c.root)
    mount(paneA, paneB)
    hidden.add(c.root)
    boot({ autoFocus: false })
    expect(controller!.focusWaiting(inputB)).toBe(true)
    expect(b.root.contains(document.activeElement)).toBe(true)
    expect(controller!.focusWaiting(inputA)).toBe(true)
    expect(a.root.contains(document.activeElement)).toBe(true)
    expect(c.root.contains(document.activeElement)).toBe(false)
  })

  it('a key acts only on the card that has the focus', () => {
    const a = approvalCard({ key: 'a' })
    const b = approvalCard({ key: 'b' })
    mount(a.root, b.root)
    boot({ autoFocus: false })
    controller!.focusWaiting(b.root)
    key(document.activeElement!, '1')
    expect(a.clicks).toEqual([])
    expect(b.clicks).toEqual(['Allow once'])
  })

  it('no card waiting: nothing to focus', () => {
    boot()
    expect(controller!.focusWaiting(document.body)).toBe(false)
  })

  it('an approval and a question card at once each answer to their own keys', () => {
    const a = approvalCard()
    const q = questionCard()
    mount(a.root, q.root)
    boot({ autoFocus: false })
    controller!.focusWaiting(q.root)
    key(document.activeElement!, '2')
    expect(q.clicks).toEqual(['Green'])
    expect(a.clicks).toEqual([])
  })
})

describe('question card', () => {
  const focused = (q: { root: HTMLElement }): Element => {
    controller!.focusWaiting(q.root)
    return document.activeElement!
  }

  it('digits pick the option and move the focus to it', () => {
    const q = questionCard()
    mount(q.root)
    boot()
    const e = key(focused(q), '2')
    expect(e.defaultPrevented).toBe(true)
    expect(q.clicks).toEqual(['Green'])
    expect(document.activeElement).toBe(q.options[1])
    key(document.activeElement!, '9')
    expect(q.clicks).toEqual(['Green'])
  })

  it('arrows move between the options and wrap', () => {
    const q = questionCard()
    mount(q.root)
    boot()
    expect(focused(q)).toBe(q.options[0])
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(q.options[1])
    key(document.activeElement!, 'ArrowUp'); key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement).toBe(q.options[2])
    key(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(q.options[0])
    expect(q.clicks).toEqual([])
  })

  it('the preselected option gets the focus first', async () => {
    const q = questionCard({ checked: [1] })
    boot()
    mount(q.root)
    await tick()
    expect(document.activeElement).toBe(q.options[1])
  })

  it('Enter on a focused, unchosen option chooses it; on the last question it also sends', () => {
    const q = questionCard({ total: 1 })
    mount(q.root)
    boot()
    focused(q)
    key(document.activeElement!, 'ArrowDown')
    key(document.activeElement!, 'Enter')
    expect(q.clicks).toEqual(['Green', 'Submit'])
  })

  it('Enter on a focused, unchosen option of an earlier question only chooses it (DSH moves on by itself)', () => {
    const q = questionCard({ total: 3, index: 0 })
    mount(q.root)
    boot()
    focused(q)
    key(document.activeElement!, 'Enter')
    expect(q.clicks).toEqual(['Red'])
  })

  it('Enter on the chosen option confirms: next / submit', () => {
    const q = questionCard({ total: 3, index: 0, checked: [0] })
    mount(q.root)
    boot()
    focused(q)
    key(document.activeElement!, 'Enter')
    expect(q.clicks).toEqual(['Next'])
  })

  it('multiple choice: digits toggle, Enter confirms (never toggles)', () => {
    const q = questionCard({ multi: true, options: ['A', 'B', 'C', 'D'] })
    mount(q.root)
    boot()
    focused(q)
    key(document.activeElement!, '1'); key(document.activeElement!, '3'); key(document.activeElement!, '1')
    expect(q.clicks).toEqual(['A', 'C', 'A'])
    key(document.activeElement!, 'Enter')
    expect(q.clicks.at(-1)).toBe('Submit')
  })

  it('Space is the browser\'s: it presses the focused option and we do not touch it', () => {
    const q = questionCard({ multi: true })
    mount(q.root)
    boot()
    focused(q)
    expect(key(document.activeElement!, ' ').defaultPrevented).toBe(false)
  })

  it('Tab goes to the custom answer; digits and Enter type there; Esc comes back to the options', () => {
    const q = questionCard()
    mount(q.root)
    boot()
    focused(q)
    const e = key(document.activeElement!, 'Tab')
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(q.textarea)
    for (const k of ['1', 'Enter', 'ArrowLeft', 'ArrowDown', 'a']) expect(key(q.textarea!, k).defaultPrevented, k).toBe(false)
    expect(key(q.textarea!, 'Backspace', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(q.clicks).toEqual([])
    key(q.textarea!, 'Escape')
    expect(document.activeElement).toBe(q.options[0])
  })

  it('Shift+Tab is left alone; with no custom field Tab is left alone', () => {
    const q = questionCard({ textarea: false })
    mount(q.root)
    boot()
    focused(q)
    expect(key(document.activeElement!, 'Tab').defaultPrevented).toBe(false)
  })

  it('left/right change question only when the pager allows it', () => {
    const middle = questionCard({ total: 3, index: 1 })
    mount(middle.root)
    boot()
    focused(middle)
    key(document.activeElement!, 'ArrowLeft'); key(document.activeElement!, 'ArrowRight')
    expect(middle.clicks).toEqual(['prev', 'next'])
    stop?.(); document.body.innerHTML = ''
    const first = questionCard({ total: 1 })
    mount(first.root)
    boot()
    focused(first)
    key(document.activeElement!, 'ArrowLeft'); key(document.activeElement!, 'ArrowRight')
    expect(first.clicks).toEqual([])
  })

  it('Ctrl+Backspace skips; plain Backspace does not', () => {
    const q = questionCard({ total: 2 })
    mount(q.root)
    boot()
    focused(q)
    expect(key(document.activeElement!, 'Backspace').defaultPrevented).toBe(false)
    expect(key(document.activeElement!, 'Backspace', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(q.clicks).toEqual(['Skip'])
  })

  it('Enter on a focused Skip / pager button is that button\'s own press', () => {
    const q = questionCard({ total: 2 })
    mount(q.root)
    boot()
    q.buttons['skip']!.focus()
    expect(key(q.buttons['skip']!, 'Enter').defaultPrevented).toBe(false)
    expect(q.clicks).toEqual([])
  })

  it('a locked (answered or read-only) card does nothing', () => {
    const q = questionCard({ locked: true })
    mount(q.root)
    boot({ autoFocus: false })
    q.root.querySelector<HTMLElement>('footer button:not([disabled])')?.focus()
    for (const k of ['1', 'Enter', 'ArrowDown']) expect(key(q.root, k).defaultPrevented, k).toBe(false)
    expect(q.clicks).toEqual([])
    expect(q.root.hasAttribute('data-ohmydsh-keys-hint')).toBe(false)
  })

  it('hints: single, multiple and a batch; multiple choice gets number badges at the end of each option', () => {
    const single = questionCard()
    const multi = questionCard({ multi: true, key: 'm', total: 3, index: 1 })
    mount(single.root, multi.root)
    boot()
    expect(hint(single.root)).toBe('1–3 choose · ↑↓ move · Enter confirm · Tab type an answer')
    expect(hint(multi.root)).toBe('1–3 toggle · ↑↓ move · Enter confirm · Tab type an answer · ←→ questions · Ctrl+Backspace skip')
    expect(single.options[0]!.getAttribute('aria-keyshortcuts')).toBe('1')
    expect(single.options[0]!.hasAttribute('data-ohmydsh-key-end')).toBe(false)
    expect(multi.options[2]!.getAttribute('data-ohmydsh-key-end')).toBe('3')
    expect(multi.buttons['skip']!.getAttribute('aria-keyshortcuts')).toBe('Control+Backspace')
    expect(multi.buttons['next']!.getAttribute('aria-keyshortcuts')).toBe('ArrowRight')
  })

  it('an optionless question is only a text field: nothing is mapped, no hint', () => {
    const q = questionCard({ options: [] })
    mount(q.root)
    boot()
    expect(q.root.hasAttribute('data-ohmydsh-keys-hint')).toBe(false)
    for (const k of ['1', 'Enter']) expect(key(q.textarea!, k).defaultPrevented).toBe(false)
  })

  it('keeps the focus in the card when DSH re-renders the options (the focused node disappears)', async () => {
    const q = questionCard({ total: 2 })
    mount(q.root)
    boot()
    focused(q)
    key(document.activeElement!, '1')
    // DSH swaps the question: old options go, focus falls to <body>
    const old = q.options[0]!
    old.remove()
    expect(document.activeElement).toBe(document.body)
    q.options[1]!.focus()
    expect(q.root.contains(document.activeElement)).toBe(true)
  })
})

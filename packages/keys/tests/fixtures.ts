// DOM fixtures shaped like the markup DSH renders for the two cards (see src/client/dom.ts for the facts relied on;
// tests/selector-guard.spec.ts checks those facts against the installed DSH).
export interface Built {
  root: HTMLElement
  buttons: Record<string, HTMLButtonElement>
  clicks: string[]
}

function button(label: string, clicks: string[], onClick?: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.addEventListener('click', () => { clicks.push(label); onClick?.() })
  return b
}

export function approvalCard(opts: { key?: string; always?: boolean; busy?: boolean } = {}): Built {
  const clicks: string[] = []
  const root = document.createElement('div')
  root.setAttribute('data-approval-key', opts.key ?? 'req-1')
  root.setAttribute('aria-busy', String(opts.busy === true))
  const card = document.createElement('div')
  const strip = document.createElement('div')
  const body = document.createElement('div')
  body.setAttribute('data-approval-scroll', '')
  body.tabIndex = 0
  body.setAttribute('role', 'group')
  body.textContent = 'Run: pnpm run build'
  const row = document.createElement('div')
  const reject = button('Reject', clicks)
  const allow = button('Allow once', clicks)
  const buttons: Record<string, HTMLButtonElement> = { reject, allow }
  row.append(reject, allow)
  if (opts.always === true) { const always = button('Always allow', clicks); buttons['always'] = always; row.append(always) }
  card.append(strip, body, row)
  root.append(card)
  return { root, buttons, clicks }
}

export interface QuestionOpts {
  key?: string
  options?: string[]
  multi?: boolean
  index?: number
  total?: number
  textarea?: boolean
  locked?: boolean
  checked?: number[]
}

export interface QuestionBuilt extends Built { options: HTMLButtonElement[]; textarea: HTMLTextAreaElement | null }

export function questionCard(opts: QuestionOpts = {}): QuestionBuilt {
  const clicks: string[] = []
  const labels = opts.options ?? ['Red', 'Green', 'Blue']
  const total = opts.total ?? 1
  const index = opts.index ?? 0
  const root = document.createElement('div')
  root.setAttribute('data-question-key', opts.key ?? 'q-1')
  const section = document.createElement('section')
  const header = document.createElement('header')
  header.append(button('minimize', clicks), button('close', clicks))
  const body = document.createElement('div')
  body.setAttribute('data-question-scroll', '')
  const group = document.createElement('div')
  group.setAttribute('role', opts.multi === true ? 'group' : 'radiogroup')
  const options: HTMLButtonElement[] = []
  labels.forEach((label, i) => {
    const row = document.createElement('div')
    row.setAttribute('data-option-row', '')
    const o = button(label, clicks, () => {
      if (opts.multi === true) o.setAttribute('aria-checked', String(o.getAttribute('aria-checked') !== 'true'))
      else for (const other of options) other.setAttribute('aria-checked', String(other === o))
    })
    o.setAttribute('role', opts.multi === true ? 'checkbox' : 'radio')
    o.setAttribute('aria-checked', String(opts.checked?.includes(i) === true))
    o.disabled = opts.locked === true
    options.push(o)
    row.append(o)
    group.append(row)
  })
  let textarea: HTMLTextAreaElement | null = null
  if (opts.textarea !== false) {
    textarea = document.createElement('textarea')
    group.append(textarea)
  }
  body.append(group)
  const footer = document.createElement('footer')
  const pager = document.createElement('div')
  const prev = button('prev', clicks)
  const next = button('next', clicks)
  prev.disabled = index === 0
  next.disabled = index === total - 1
  const progress = document.createElement('span')
  progress.textContent = `${String(index + 1)} / ${String(total)}`
  pager.append(prev, progress, next)
  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  const actions = document.createElement('div')
  const skip = button('Skip', clicks)
  const primary = button(index === total - 1 ? 'Submit' : 'Next', clicks)
  actions.append(skip, primary)
  footer.append(pager, status, actions)
  section.append(header, body, footer)
  root.append(section)
  return { root, buttons: { prev, next, skip, primary }, clicks, options, textarea }
}

export function key(target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: k, code: /^[0-9]$/.test(k) ? `Digit${k}` : k, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

// `/?settings=phone` opens Settings > Phone app. Core has no public "open this settings section" call for plugins (the
// launcher seat belongs to the account menu), so this drives the same controls a person would: account menu > Settings,
// then the section in the navigation. Bounded (10 s, polling), runs only when the parameter is present, and gives up
// quietly: the worst case is that the person opens Settings by hand. While another modal dialog is open (DSH's "Preview
// Notice" on the very first start) nothing is clicked behind it and the 10 s only start once the person has dismissed it
// (waiting at most 5 minutes in total).

export interface DeepLinkDeps {
  readonly document: Document
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>
  readonly replaceUrl: (url: string) => void
  readonly sectionLabel: string
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

const PARAM = 'settings'
const VALUE = 'phone'

const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

/** A menu entry may carry its keyboard shortcut after the label ("Settings⌥⌘," on macOS, "SettingsCtrl+," elsewhere). */
function labelled(el: Element, label: string): boolean {
  const t = text(el)
  if (t === label || el.getAttribute('aria-label') === label) return true
  return t.startsWith(label) && /^\s?(?:[⌘⌥⌃⇧]|Ctrl|Cmd|Alt|Shift|Meta|Option)/.test(t.slice(label.length))
}

function find(doc: Document, selector: string, label: string): HTMLElement | undefined {
  return [...doc.querySelectorAll<HTMLElement>(selector)].find((el) => labelled(el, label))
}

/** True when the landing URL asks for it. */
export function wantsPhoneSettings(search: string): boolean {
  return new URLSearchParams(search).get(PARAM) === VALUE
}

export function cleanSettingsParam(location: DeepLinkDeps['location']): string {
  const params = new URLSearchParams(location.search)
  params.delete(PARAM)
  const query = params.toString()
  return `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`
}

/** @returns true when the section is open. */
export async function openPhoneSettings(deps: DeepLinkDeps): Promise<boolean> {
  const { document: doc } = deps
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms) }))
  deps.replaceUrl(cleanSettingsParam(deps.location))
  const started = now()
  let deadline = started + 10_000
  const blocked = (): boolean => doc.querySelector('[role="dialog"][aria-modal="true"]:not([data-shortcut-modal="settings"])') !== null
  const dialog = (): HTMLElement | null => doc.querySelector<HTMLElement>('[data-shortcut-modal="settings"]')
  // A click can be lost (a first-start dialog opening right after it closes the menu again), so each click is retried when
  // nothing followed it within RETRY_MS.
  const RETRY_MS = 2_000
  let clickedMenu = -Infinity
  let clickedSettings = -Infinity
  while (now() < deadline) {
    if (blocked() && now() - started < 300_000) { deadline = now() + 10_000; clickedMenu = -Infinity; clickedSettings = -Infinity; await sleep(150); continue }
    const open = dialog()
    if (open !== null) {
      const nav = [...open.querySelectorAll<HTMLElement>('nav button')].find((b) => text(b) === deps.sectionLabel)
      if (nav !== undefined) {
        if (nav.getAttribute('aria-current') !== 'true') nav.click()
        return true
      }
    } else if (now() - clickedSettings > RETRY_MS) {
      // A plain Settings button (shells without the account menu) or the account menu's Settings entry.
      const direct = find(doc, 'button[aria-haspopup="dialog"]', 'Settings')
      const item = find(doc, '[role="menuitem"]', 'Settings')
      if (direct !== undefined) { direct.click(); clickedSettings = now() }
      else if (item !== undefined) { item.click(); clickedSettings = now() }
      else if (now() - clickedMenu > RETRY_MS) {
        const menu = find(doc, 'button[aria-haspopup]', 'Account menu') ?? find(doc, 'button', 'Account menu')
        // The menu button toggles: only press it when the menu is closed.
        if (menu !== undefined && menu.getAttribute('aria-expanded') !== 'true') { menu.click(); clickedMenu = now() } else if (menu !== undefined) clickedMenu = now()
      }
    }
    await sleep(150)
  }
  return false
}

// `/?settings=phone` opens Settings > Phone app. Core has no public "open this settings section" call for plugins (the
// launcher seat belongs to the account menu), so this drives the same controls a person would: account menu > Settings,
// then the section in the navigation. Bounded (10 s, polling), runs only when the parameter is present, and gives up
// quietly: the worst case is that the person opens Settings by hand.

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

function find(doc: Document, selector: string, label: string): HTMLElement | undefined {
  return [...doc.querySelectorAll<HTMLElement>(selector)].find((el) => text(el) === label || el.getAttribute('aria-label') === label)
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
  const deadline = now() + 10_000
  const dialog = (): HTMLElement | null => doc.querySelector<HTMLElement>('[data-shortcut-modal="settings"]')
  let clickedMenu = false
  let clickedSettings = false
  while (now() < deadline) {
    const open = dialog()
    if (open !== null) {
      const nav = [...open.querySelectorAll<HTMLElement>('nav button')].find((b) => text(b) === deps.sectionLabel)
      if (nav !== undefined) {
        if (nav.getAttribute('aria-current') !== 'true') nav.click()
        return true
      }
    } else if (!clickedSettings) {
      // A plain Settings button (shells without the account menu) or the account menu's Settings entry.
      const direct = find(doc, 'button[aria-haspopup="dialog"]', 'Settings')
      const item = find(doc, '[role="menuitem"]', 'Settings')
      if (direct !== undefined) { direct.click(); clickedSettings = true }
      else if (item !== undefined) { item.click(); clickedSettings = true }
      else if (!clickedMenu) {
        const menu = find(doc, 'button[aria-haspopup]', 'Account menu') ?? find(doc, 'button', 'Account menu')
        if (menu !== undefined) { menu.click(); clickedMenu = true }
      }
    }
    await sleep(150)
  }
  return false
}

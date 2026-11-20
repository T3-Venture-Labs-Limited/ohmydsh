import { afterEach, describe, expect, it } from 'vitest'
import { cleanSettingsParam, openPhoneSettings, wantsPhoneSettings } from '../src/client/deeplink.ts'

afterEach(() => { document.body.innerHTML = '' })

const deps = (over: Partial<Parameters<typeof openPhoneSettings>[0]> = {}) => {
  let t = 0
  const replaced: string[] = []
  return { replaced, d: { document, location: { pathname: '/', search: '?settings=phone&x=1', hash: '' }, replaceUrl: (u: string) => replaced.push(u), sectionLabel: 'Phone app', now: () => t, sleep: async (ms: number) => { t += ms }, ...over } }
}

/** A minimal stand-in for DSH's shell: account menu button -> menu with Settings -> dialog with nav buttons. */
function shell(): { opened: () => boolean; selected: () => string } {
  let selected = ''
  document.body.innerHTML = '<button aria-label="Account menu" aria-haspopup="menu">A</button>'
  const menuButton = document.querySelector<HTMLButtonElement>('button')!
  menuButton.addEventListener('click', () => {
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu')
    menu.innerHTML = '<div role="menuitem">Settings</div><div role="menuitem">Feedback</div>'
    document.body.append(menu)
    menu.querySelector<HTMLElement>('[role=menuitem]')!.addEventListener('click', () => {
      const dialog = document.createElement('div'); dialog.setAttribute('data-shortcut-modal', 'settings')
      dialog.innerHTML = '<nav><button>General</button><button>Phone app</button></nav>'
      dialog.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { selected = b.textContent ?? '' }))
      document.body.append(dialog)
    })
  })
  return { opened: () => document.querySelector('[data-shortcut-modal=settings]') !== null, selected: () => selected }
}

describe('settings deep link', () => {
  it('recognises only settings=phone and cleans just that parameter', () => {
    expect(wantsPhoneSettings('?settings=phone')).toBe(true)
    for (const s of ['', '?settings=general', '?settings=', '?x=phone']) expect(wantsPhoneSettings(s), s).toBe(false)
    expect(cleanSettingsParam({ pathname: '/', search: '?settings=phone&openSession=a', hash: '#h' })).toBe('/?openSession=a#h')
    expect(cleanSettingsParam({ pathname: '/', search: '?settings=phone', hash: '' })).toBe('/')
  })
  it('opens the account menu, Settings, then the Phone app section, and removes the parameter', async () => {
    const dom = shell(); const { d, replaced } = deps()
    expect(await openPhoneSettings(d)).toBe(true)
    expect(dom.opened()).toBe(true); expect(dom.selected()).toBe('Phone app'); expect(replaced).toEqual(['/?x=1'])
  })
  it('uses a plain Settings button when there is no account menu', async () => {
    document.body.innerHTML = '<button aria-haspopup="dialog" aria-label="Settings">S</button>'
    document.querySelector('button')!.addEventListener('click', () => {
      const dialog = document.createElement('div'); dialog.setAttribute('data-shortcut-modal', 'settings')
      dialog.innerHTML = '<nav><button aria-current="true">Phone app</button></nav>'; document.body.append(dialog)
    })
    expect(await openPhoneSettings(deps().d)).toBe(true)
  })
  it('gives up after 10 seconds when the shell never shows up, without throwing', async () => {
    const { d } = deps(); let slept = 0
    expect(await openPhoneSettings({ ...d, sleep: async (ms) => { slept += ms; await d.sleep!(ms) } })).toBe(false)
    expect(slept).toBeGreaterThanOrEqual(10_000)
  })
  it('does not open anything the person did not ask for (no Settings entry named Phone app -> false)', async () => {
    shell()
    expect(await openPhoneSettings(deps({ sectionLabel: 'Nonexistent' }).d)).toBe(false)
  })
  it('waits behind a blocking notice (first start) and clicks nothing until it is dismissed', async () => {
    const s = shell()
    const notice = document.createElement('div'); notice.setAttribute('role', 'dialog'); notice.setAttribute('aria-modal', 'true'); notice.setAttribute('aria-label', 'Preview Notice')
    document.body.append(notice)
    const { d } = deps(); let waited = 0
    const done = openPhoneSettings({ ...d, sleep: async (ms) => { waited += ms; await d.sleep!(ms); if (waited >= 40_000) notice.remove() } })
    expect(await done).toBe(true) // 40 s of notice is longer than the usual 10 s limit
    expect(waited).toBeGreaterThanOrEqual(40_000)
    expect(s.selected()).toBe('Phone app')
  })
  it('gives up when a notice stays for good (5 minutes) instead of waiting forever', async () => {
    const notice = document.createElement('div'); notice.setAttribute('role', 'dialog'); notice.setAttribute('aria-modal', 'true'); document.body.append(notice)
    expect(await openPhoneSettings(deps().d)).toBe(false)
  })
  it('retries a lost click: a first-start dialog that swallowed the menu click does not leave the link dead', async () => {
    let swallowed = 0
    document.body.innerHTML = '<button aria-label="Account menu" aria-haspopup="menu" aria-expanded="false">A</button>'
    const menuButton = document.querySelector<HTMLButtonElement>('button')!
    menuButton.addEventListener('click', () => {
      if (swallowed < 2) { swallowed += 1; return } // the first two presses are lost
      const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.innerHTML = '<div role="menuitem">Settings</div>'
      document.body.append(menu)
      menu.querySelector<HTMLElement>('[role=menuitem]')!.addEventListener('click', () => {
        const dialog = document.createElement('div'); dialog.setAttribute('data-shortcut-modal', 'settings')
        dialog.innerHTML = '<nav><button aria-current="true">Phone app</button></nav>'; document.body.append(dialog)
      })
    })
    expect(await openPhoneSettings(deps().d)).toBe(true)
    expect(swallowed).toBe(2)
  })
  it('finds the Settings entry when it shows its shortcut (macOS "Settings⌥⌘,", Windows "SettingsCtrl+,") but not other entries', async () => {
    for (const label of ['Settings⌥⌘,', 'SettingsCtrl+,']) {
      document.body.innerHTML = '<button aria-label="Account menu" aria-haspopup="menu" aria-expanded="false">A</button>'
      document.querySelector('button')!.addEventListener('click', () => {
        const menu = document.createElement('div'); menu.setAttribute('role', 'menu')
        menu.innerHTML = `<div role="menuitem">Settings Advanced</div><div role="menuitem">${label}</div>`
        document.body.append(menu)
        menu.querySelectorAll<HTMLElement>('[role=menuitem]')[1]!.addEventListener('click', () => {
          const dialog = document.createElement('div'); dialog.setAttribute('data-shortcut-modal', 'settings')
          dialog.innerHTML = '<nav><button aria-current="true">Phone app</button></nav>'; document.body.append(dialog)
        })
      })
      expect(await openPhoneSettings(deps().d), label).toBe(true)
      document.body.innerHTML = ''
    }
  })
})

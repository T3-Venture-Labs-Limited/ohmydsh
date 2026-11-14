import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Button, IconButton, Switch, SegmentedControl, TextField, Select, Modal, Tooltip, Page, Section, Card, SettingsRow, EmptyState, defineLocale,
} from '../ui/index.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); document.head.querySelectorAll('style[data-dk-styles]').forEach((s) => s.remove()) })
const render = (node: React.ReactNode) => { act(() => root.render(node)) }

describe('Switch', () => {
  it('is a role=switch with aria-checked and toggles', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} label="Enable" />)
    const el = host.querySelector('button')!
    expect(el.getAttribute('role')).toBe('switch')
    expect(el.getAttribute('aria-checked')).toBe('false')
    expect(el.getAttribute('aria-label')).toBe('Enable')
    act(() => el.click())
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('Button / IconButton', () => {
  it('defaults to type=button and requires a label for icon buttons', () => {
    render(<><Button>Go</Button><IconButton label="Close" icon={<i />} /></>)
    const [a, b] = [...host.querySelectorAll('button')]
    expect(a!.type).toBe('button')
    expect(b!.getAttribute('aria-label')).toBe('Close')
  })
})

describe('SegmentedControl', () => {
  function Demo() {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a')
    return <SegmentedControl id="seg" label="Mode" value={v} onChange={setV} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }]} />
  }
  it('walks with arrows skipping disabled and wraps', () => {
    render(<Demo />)
    const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')]
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    act(() => { tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(tabs()[2]!.getAttribute('aria-selected')).toBe('true')
    act(() => { tabs()[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('[role=tablist]')!.getAttribute('aria-label')).toBe('Mode')
  })
})

describe('fields', () => {
  it('TextField links label, hint and error', () => {
    render(<TextField label="Name" hint="Required" error="Too short" defaultValue="x" />)
    const input = host.querySelector('input')!
    expect(host.querySelector('label')!.getAttribute('for')).toBe(input.id)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(host.querySelector('[role=alert]')!.textContent).toBe('Too short')
  })
  it('Select reports the chosen value', () => {
    const onChange = vi.fn()
    render(<Select label="Model" value="a" onChange={onChange} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    const sel = host.querySelector('select')!
    act(() => { sel.value = 'b'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(onChange).toHaveBeenCalledWith('b')
  })
})

describe('Modal', () => {
  function Demo({ onClose }: { onClose: () => void }) {
    return (
      <Modal open title="Rename" closeLabel="Close" onClose={onClose} footer={<Button>Save</Button>}>
        <input data-modal-autofocus aria-label="name" />
      </Modal>
    )
  }
  it('renders an aria-modal dialog, focuses autofocus target, closes on Escape and mask click', () => {
    const onClose = vi.fn()
    render(<Demo onClose={onClose} />)
    const dialog = document.body.querySelector('[role=dialog]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Rename')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('name')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => (document.body.querySelector('.dk-modal-mask') as HTMLElement).click())
    expect(onClose).toHaveBeenCalledTimes(2)
  })
  it('owns Escape ahead of an earlier bubble listener (a host dialog underneath)', () => {
    const host2 = vi.fn()
    document.addEventListener('keydown', host2)
    render(<Demo onClose={() => {}} />)
    act(() => { document.body.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(host2).not.toHaveBeenCalled()
    document.removeEventListener('keydown', host2)
  })
  it('traps Tab and restores focus on close', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    function Wrap() {
      const [open, setOpen] = useState(true)
      return <Modal open={open} title="T" closeLabel="Close" onClose={() => setOpen(false)}><input aria-label="one" data-modal-autofocus /></Modal>
    }
    render(<Wrap />)
    const buttons = [...document.body.querySelectorAll<HTMLElement>('[role=dialog] button, [role=dialog] input')]
    const last = buttons[buttons.length - 1]!
    last.focus()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => { document.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(buttons[0])
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.body.querySelector('[role=dialog]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
  it('removes the stylesheet when the last kit surface unmounts', () => {
    render(<Demo onClose={() => {}} />)
    expect(document.head.querySelectorAll('style[data-dk-styles]').length).toBe(1)
    act(() => root.render(null))
    expect(document.head.querySelectorAll('style[data-dk-styles]').length).toBe(0)
  })
})

describe('Tooltip', () => {
  it('shows on keyboard focus, hides on blur and click, keeps child ref and handlers', () => {
    const ref = { current: null as HTMLElement | null }
    const onClick = vi.fn()
    render(<Tooltip label="Hello" delayMs={0}><button ref={ref as React.RefObject<HTMLButtonElement>} onClick={onClick}>x</button></Tooltip>)
    const btn = host.querySelector('button')!
    expect(ref.current).toBe(btn)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); btn.focus() })
    expect(document.body.querySelector('[role=tooltip]')?.textContent).toBe('Hello')
    expect(btn.getAttribute('aria-describedby')).toBeTruthy()
    act(() => btn.click())
    expect(onClick).toHaveBeenCalled()
    expect(document.body.querySelector('[role=tooltip]')).toBeNull()
  })
})

describe('patterns and locale', () => {
  it('renders Page > Section > Card > SettingsRow and EmptyState', () => {
    render(<Page title="T" description="D"><Section title="S"><Card><SettingsRow title="Row" description="d"><Switch checked onChange={() => {}} label="x" /></SettingsRow></Card></Section><EmptyState title="Nothing" tone="error" /></Page>)
    expect(host.querySelector('h1')!.textContent).toBe('T')
    expect(host.querySelector('.dk-settings-row__title')!.textContent).toBe('Row')
    expect(host.querySelector('.dk-empty')!.getAttribute('data-tone')).toBe('error')
  })
  it('defineLocale registers English and translates through ctx.locale', () => {
    const store = new Map<string, Record<string, string>>()
    const face = {
      register: (ns: string, _l: string, d: Record<string, string>) => { store.set(ns, d); return () => store.delete(ns) },
      bind: (ns: string) => (k: string, p?: Record<string, unknown>) => (store.get(ns)?.[k] ?? k).replace(/\{(\w+)\}/g, (_m, n: string) => String(p?.[n])),
    }
    const loc = defineLocale('demo', { hello: 'Hello {name}' })
    const off = loc.register(face)
    expect(loc.bind(face)('hello', { name: 'Ada' })).toBe('Hello Ada')
    off()
    expect(store.has('demo')).toBe(false)
  })
})

describe('hideLabel', () => {
  it('keeps the label for assistive tech but visually hides it', () => {
    render(<Select label="Model" hideLabel value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }]} />)
    const label = host.querySelector('label')!
    expect(label.className).toContain('dk-visually-hidden')
    expect(label.getAttribute('for')).toBe(host.querySelector('select')!.id)
  })
})

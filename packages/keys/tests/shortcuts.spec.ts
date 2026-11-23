import { describe, expect, it, vi } from 'vitest'
import { bindingIssue, effectiveShortcuts, initialShortcutConfig, isWebBindingAllowed, normalizeBinding, parseShortcutDefinitions, resolveShortcutDefault } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { locale } from '../src/client/locale.ts'
import { FOCUS_ID, focusKeysText, registerShortcuts } from '../src/client/shortcuts.ts'
import type { ShortcutsFace } from '../src/client/shortcuts.ts'

const t = locale.bind({ register: () => () => {}, bind: () => (key: string) => (locale.en as Record<string, string>)[key] ?? key })

interface Recorded { commands: Record<string, unknown>[]; fixed: Record<string, unknown>[]; observers: ((input: never) => void)[]; disposed: string[] }

function fakeFace(runtime: 'desktop' | 'web', platform: 'macos' | 'windows' | 'linux', opts: { failOn?: string } = {}): { face: ShortcutsFace; rec: Recorded } {
  const rec: Recorded = { commands: [], fixed: [], observers: [], disposed: [] }
  const face = {
    runtime, platform,
    catalog: { getSnapshot: () => [] as never[], subscribe: () => () => {} },
    register(command: Record<string, unknown>) {
      if (opts.failOn === command['id']) throw new Error('Conflicting shortcut defaults')
      rec.commands.push(command)
      return () => { rec.disposed.push(String(command['id'])) }
    },
    registerFixed(command: Record<string, unknown>) {
      if (opts.failOn === command['id']) throw new Error('Duplicate shortcut command')
      rec.fixed.push(command)
      return () => { rec.disposed.push(String(command['id'])) }
    },
    observeFixedInput(listener: (input: never) => void) { rec.observers.push(listener); return () => { rec.disposed.push('observer') } },
  } as unknown as ShortcutsFace
  return { face, rec }
}

const run = (face: ShortcutsFace, focus: (from: Element | null) => boolean = () => true, warn = vi.fn()): { warn: ReturnType<typeof vi.fn> } => {
  registerShortcuts((fn) => { fn() }, face, t, focus, warn)
  return { warn }
}

describe('the focus command', () => {
  it.each([['desktop', 'linux'], ['desktop', 'windows'], ['desktop', 'macos'], ['web', 'windows'], ['web', 'macos']] as const)('%s:%s registers Ctrl+Alt+J (Cmd+Alt+J on macOS), never plain Ctrl+J', (runtime, platform) => {
    const { face, rec } = fakeFace(runtime, platform)
    run(face)
    const command = rec.commands.find((c) => c['id'] === FOCUS_ID) as { defaults: Record<string, { code: string; modifiers: string[] }>; regions: string[]; modals: string[] }
    expect(command).toBeDefined()
    const binding = command.defaults[`${runtime}:${platform}`]!
    expect(binding).toEqual({ code: 'KeyJ', modifiers: ['primary', 'alt'] })
    expect(command.regions).toContain('editable')
    expect(command.regions).toContain('page')
    expect(command.modals).toEqual([])
  })

  it('resolve hands over to the focus when a card is waiting, and passes the key on when none is', () => {
    const { face, rec } = fakeFace('desktop', 'linux')
    const seen: (Element | null)[] = []
    let waiting = true
    run(face, (from) => { seen.push(from); return waiting })
    const command = rec.commands[0] as { resolve(context: { target: Element | null }): { status: string } }
    const target = document.createElement('div')
    expect(command.resolve({ target }).status).toBe('handled')
    waiting = false
    expect(command.resolve({ target }).status).toBe('pass')
    expect(seen).toEqual([target, target])
  })

  it('a browser on Linux (the service accepts no editable Ctrl+Alt+J there) gets a fixed row handled from fixed input', () => {
    const { face, rec } = fakeFace('web', 'linux')
    const calls: (Element | null)[] = []
    run(face, (from) => { calls.push(from); return true })
    expect(rec.commands).toEqual([])
    expect(rec.fixed.find((f) => f['id'] === FOCUS_ID)).toMatchObject({ keys: ['Ctrl', 'Alt', 'J'], bindings: [{ code: 'KeyJ', modifiers: ['control', 'alt'] }] })
    const observer = rec.observers[0]!
    const consume = vi.fn()
    const target = document.createElement('div')
    const gesture = { code: 'KeyJ', control: true, alt: true, shift: false, meta: false, repeat: false, composing: false, defaultPrevented: false }
    observer({ type: 'keydown', gesture, context: { target, modal: null }, consume } as never)
    expect(consume).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([target])
    for (const bad of [{ control: false }, { alt: false }, { shift: true }, { repeat: true }, { composing: true }, { defaultPrevented: true }, { code: 'KeyK' }]) {
      observer({ type: 'keydown', gesture: { ...gesture, ...bad }, context: { target, modal: null }, consume } as never)
    }
    observer({ type: 'keydown', gesture, context: { target, modal: 'settings' }, consume } as never)
    observer({ type: 'reset' } as never)
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('a refusal by the service (a conflicting default) disables that row only and is logged', () => {
    const { face, rec } = fakeFace('desktop', 'linux', { failOn: FOCUS_ID })
    const { warn } = run(face)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('focus shortcut')
    expect(rec.fixed.length).toBeGreaterThan(0)
  })

  it('is cleaned up by the owning effects', () => {
    const { face, rec } = fakeFace('desktop', 'linux')
    const disposers: (() => void)[] = []
    registerShortcuts((fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off) }, face, t, () => true)
    for (const off of disposers) off()
    expect(rec.disposed).toContain(FOCUS_ID)
    expect(rec.disposed.length).toBe(rec.commands.length + rec.fixed.length)
  })
})

describe('the reference rows', () => {
  it('lists the plain keys read-only, with distinct ids, in the right groups', () => {
    const { face, rec } = fakeFace('desktop', 'linux')
    run(face)
    const ids = rec.fixed.map((f) => f['id'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['ohmydsh.keys.approvalChoose', 'ohmydsh.keys.questionChoose', 'ohmydsh.keys.questionMove', 'ohmydsh.keys.questionPager', 'ohmydsh.keys.questionSkip', 'ohmydsh.keys.questionOther'])
    expect(rec.fixed.find((f) => f['id'] === 'ohmydsh.keys.approvalChoose')).toMatchObject({ group: 'approval', keys: ['1–3'] })
    expect(rec.fixed.find((f) => f['id'] === 'ohmydsh.keys.questionSkip')).toMatchObject({ keys: ['Ctrl', 'Backspace'], bindings: [{ code: 'Backspace', modifiers: ['control'] }] })
  })

  it('the skip row shows ⌃ on macOS and a plus on Windows', () => {
    for (const [platform, keys] of [['macos', ['⌃', 'Backspace']], ['windows', ['Ctrl', '+', 'Backspace']]] as const) {
      const { face, rec } = fakeFace('desktop', platform)
      run(face)
      expect(rec.fixed.find((f) => f['id'] === 'ohmydsh.keys.questionSkip')).toMatchObject({ keys })
    }
  })
})

describe('what the shortcut service itself accepts (its own validation, from the installed package)', () => {
  const profiles = [['desktop', 'linux'], ['desktop', 'windows'], ['desktop', 'macos'], ['web', 'windows'], ['web', 'macos'], ['web', 'linux']] as const

  it.each(profiles)('%s:%s: every definition passes parseShortcutDefinitions, and none is flagged reserved or conflicting', (runtime, platform) => {
    const { face, rec } = fakeFace(runtime, platform)
    run(face)
    const definitions = [
      ...rec.commands.map((c) => ({ id: c['id'] as string, defaults: c['defaults'] as Record<string, never> })),
      ...rec.fixed.map((f) => ({ id: f['id'] as string, defaults: {}, fixed: f['bindings'] as never })),
    ]
    expect(() => parseShortcutDefinitions(definitions)).not.toThrow()
    const rows = effectiveShortcuts(definitions as never, initialShortcutConfig().document, runtime, platform)
    for (const row of rows) {
      expect(row.issue, `${row.id} issue`).toBeNull()
      expect(row.conflicts, `${row.id} conflicts`).toEqual([])
    }
  })

  it.each(profiles.filter(([r, p]) => !(r === 'web' && p === 'linux')))('%s:%s: the focus default is allowed there (browsers accept only a few combinations)', (runtime, platform) => {
    const { face, rec } = fakeFace(runtime, platform)
    run(face)
    const command = rec.commands[0] as { defaults: Record<string, never> }
    const binding = normalizeBinding(resolveShortcutDefault({ id: FOCUS_ID as never, defaults: command.defaults }, runtime, platform)!, platform)
    expect(bindingIssue(binding, runtime, platform)).toBeNull()
    if (runtime === 'web') expect(isWebBindingAllowed(binding, platform)).toBe(true)
  })

  it('the Linux browser has no allowed editable Ctrl+Alt+J (the reason for its fixed row)', () => {
    const binding = normalizeBinding({ code: 'KeyJ', modifiers: ['primary', 'alt'] }, 'linux')
    expect(isWebBindingAllowed(binding, 'linux')).toBe(false)
  })

  it('does not claim Ctrl+J: dsh-hotkey (part of the ohmydsh set) owns it for its session switcher', () => {
    const { face, rec } = fakeFace('desktop', 'linux')
    run(face)
    const all = [...rec.commands.flatMap((c) => Object.values(c['defaults'] as Record<string, { code: string; modifiers: string[] }>)), ...rec.fixed.flatMap((f) => f['bindings'] as { code: string; modifiers: string[] }[])]
    expect(all.filter((b) => b.code === 'KeyJ' && b.modifiers.length === 1 && b.modifiers[0] !== 'alt')).toEqual([])
  })
})

describe('focusKeysText', () => {
  const entry = (keys: string[], binding: unknown = {}) => ({ id: FOCUS_ID, keys, binding })
  const face = (platform: 'macos' | 'windows' | 'linux', rows: unknown[], runtime: 'desktop' | 'web' = 'desktop'): ShortcutsFace =>
    ({ runtime, platform, catalog: { getSnapshot: () => rows, subscribe: () => () => {} } }) as unknown as ShortcutsFace

  it('formats the way the service shows it', () => {
    expect(focusKeysText(face('linux', [entry(['Ctrl', 'Alt', 'J'])]))).toBe('Ctrl+Alt+J')
    expect(focusKeysText(face('windows', [entry(['Ctrl', '+', 'Alt', '+', 'J'])]))).toBe('Ctrl+Alt+J')
    expect(focusKeysText(face('macos', [entry(['⌃', '⌥', 'J'])]))).toBe('⌃⌥J')
  })
  it('is undefined when unbound, except for the Linux browser fixed row', () => {
    expect(focusKeysText(face('linux', [entry([], null)]))).toBeUndefined()
    expect(focusKeysText(face('linux', []))).toBeUndefined()
    expect(focusKeysText(face('linux', [], 'web'))).toBe('Ctrl+Alt+J')
  })
})

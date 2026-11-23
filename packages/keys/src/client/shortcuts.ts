// Registration with DSH's shortcut service (ctx.shortcuts), through local minimal types so this file does not pull the
// service's type graph in.
//
// Default chord: Ctrl+Alt+J (Cmd+Alt+J on macOS). Plain Ctrl+J is taken in the ohmydsh set by dsh-hotkey (its session switcher).
// What the service lets a plugin rebind: only combinations with a modifier (plain digits, arrows, Enter, Esc, Tab and
// Backspace are "reserved" on Linux and in the browser, and rejected as an editable default there). So:
//   - `ohmydsh.keys.focus` (Ctrl+Alt+J, Cmd+Alt+J on macOS) is a real command: Settings > Shortcuts lists it, you can rebind it;
//   - the plain keys are listed as read-only reference rows (registerFixed), so they show in the reference and are
//     protected from being assigned to something else.
// Browsers (web runtime) accept only a few combinations as editable defaults; Ctrl+Alt+J is one on Windows and macOS, but not
// on Linux, where a fixed Ctrl+Alt+J row handled from observeFixedInput takes its place (it is not rebindable there).
import type { T } from './locale.ts'

type Modifier = 'primary' | 'control' | 'alt' | 'shift' | 'meta'
interface Binding { readonly code: string; readonly modifiers: readonly Modifier[] }
type Profile = `${'desktop' | 'web'}:${'macos' | 'windows' | 'linux'}`

interface FixedCommand {
  readonly id: string
  readonly label: () => string
  readonly keys: readonly string[]
  readonly bindings: readonly [Binding, ...Binding[]]
  readonly group: 'application' | 'input' | 'menus' | 'approval'
}

interface Resolution { status: 'handled'; run(): void }
type MaybeResolution = Resolution | { status: 'pass' }

interface CatalogEntry { readonly id: string; readonly keys: readonly string[]; readonly binding: unknown }

export interface ShortcutsFace {
  readonly runtime: 'desktop' | 'web'
  readonly platform: 'macos' | 'windows' | 'linux'
  readonly catalog: { getSnapshot(): readonly CatalogEntry[]; subscribe(listener: () => void): () => void }
  register(command: {
    id: string
    label: () => string
    aliases: readonly string[]
    defaults: Partial<Record<Profile, Binding>>
    regions: readonly ('page' | 'editable' | 'terminal')[]
    modals: readonly string[]
    resolve(context: { target: Element | null }): MaybeResolution
  }): () => void
  registerFixed(command: FixedCommand): () => void
  observeFixedInput(listener: (input: { type: 'reset' } | { type: 'keydown'; gesture: { code: string; control: boolean; alt: boolean; shift: boolean; meta: boolean; repeat: boolean; composing: boolean; defaultPrevented: boolean }; context: { target: Element | null; modal: string | null }; consume(): void }) => void): () => void
}

export const FOCUS_ID = 'ohmydsh.keys.focus'

const digits = (from: number, to: number): [Binding, ...Binding[]] => {
  const list: Binding[] = []
  for (let n = from; n <= to; n++) list.push({ code: `Digit${String(n)}`, modifiers: [] })
  return list as [Binding, ...Binding[]]
}

/** Display text of the focus shortcut as the service renders it ("Ctrl+J", "⌘J"), or undefined when it is unbound. */
export function focusKeysText(face: ShortcutsFace): string | undefined {
  const entry = face.catalog.getSnapshot().find((e) => e.id === FOCUS_ID)
  if (entry === undefined || entry.binding === null || entry.keys.length === 0) return face.runtime === 'web' && face.platform === 'linux' ? 'Ctrl+Alt+J' : undefined
  return face.platform === 'macos' ? entry.keys.join('') : entry.keys.includes('+') ? entry.keys.join('') : entry.keys.join('+')
}

/**
 * Register the focus command and the reference rows. Every registration is its own effect, so one refusal (a duplicate id,
 * a combination another plugin already owns) disables only that row and is logged, never the plugin.
 */
export function registerShortcuts(
  effect: (fn: () => (() => void) | void, label: string) => void,
  face: ShortcutsFace,
  t: T,
  focusWaiting: (from: Element | null) => boolean,
  warn: (message: string, error: unknown) => void = (m, e) => { console.warn(m, e) },
): void {
  const safe = (label: string, fn: () => () => void): void => {
    effect(() => { try { return fn() } catch (error) { warn(`ohmydsh-keys: ${label} was not registered`, error); return undefined } }, `ohmydsh-keys: ${label}`)
  }
  const defaults: Partial<Record<Profile, Binding>> = {
    'desktop:macos': { code: 'KeyJ', modifiers: ['primary', 'alt'] },
    'desktop:windows': { code: 'KeyJ', modifiers: ['primary', 'alt'] },
    'desktop:linux': { code: 'KeyJ', modifiers: ['primary', 'alt'] },
    // Browsers accept only a few combinations as editable defaults; Linux gets the fixed row below instead.
    'web:macos': { code: 'KeyJ', modifiers: ['primary', 'alt'] },
    'web:windows': { code: 'KeyJ', modifiers: ['primary', 'alt'] },
  }
  if (face.runtime === 'web' && face.platform === 'linux') {
    safe('focus shortcut (fixed)', () => {
      const dispose = face.registerFixed({ id: FOCUS_ID, label: () => t('focusLabel'), keys: ['Ctrl', 'Alt', 'J'], bindings: [{ code: 'KeyJ', modifiers: ['control', 'alt'] }], group: 'approval' })
      const off = face.observeFixedInput((input) => {
        if (input.type !== 'keydown') return
        const { gesture, context } = input
        if (gesture.code !== 'KeyJ' || !gesture.control || !gesture.alt || gesture.shift || gesture.meta || gesture.repeat || gesture.composing || gesture.defaultPrevented || context.modal !== null) return
        if (focusWaiting(context.target)) input.consume()
      })
      return () => { off(); dispose() }
    })
  } else {
    safe('focus shortcut', () => face.register({
      id: FOCUS_ID,
      label: () => t('focusLabel'),
      aliases: ['approve', 'answer', 'question', 'approval', 'keyboard'],
      defaults,
      // From the composer too: the whole point is to jump to the card while you are typing something else.
      regions: ['page', 'editable'],
      modals: [],
      resolve: (context) => (focusWaiting(context.target) ? { status: 'handled', run: () => undefined } : { status: 'pass' }),
    }))
  }

  const ctrlKeys = face.platform === 'macos' ? ['⌃', 'Backspace'] : face.platform === 'windows' ? ['Ctrl', '+', 'Backspace'] : ['Ctrl', 'Backspace']
  const rows: { id: string; label: () => string; keys: readonly string[]; bindings: [Binding, ...Binding[]]; group: FixedCommand['group'] }[] = [
    { id: 'ohmydsh.keys.approvalChoose', label: () => t('rowApprovalChoose'), keys: ['1–3'], bindings: digits(1, 3), group: 'approval' },
    { id: 'ohmydsh.keys.questionChoose', label: () => t('rowQuestionChoose'), keys: ['1–9'], bindings: digits(1, 9), group: 'input' },
    { id: 'ohmydsh.keys.questionMove', label: () => t('rowQuestionMove'), keys: ['↑', '↓'], bindings: [{ code: 'ArrowUp', modifiers: [] }, { code: 'ArrowDown', modifiers: [] }], group: 'input' },
    { id: 'ohmydsh.keys.questionPager', label: () => t('rowQuestionPager'), keys: ['←', '→'], bindings: [{ code: 'ArrowLeft', modifiers: [] }, { code: 'ArrowRight', modifiers: [] }], group: 'input' },
    { id: 'ohmydsh.keys.questionSkip', label: () => t('rowQuestionSkip'), keys: ctrlKeys, bindings: [{ code: 'Backspace', modifiers: ['control'] }], group: 'input' },
    { id: 'ohmydsh.keys.questionOther', label: () => t('rowQuestionOther'), keys: ['Tab'], bindings: [{ code: 'Tab', modifiers: [] }], group: 'input' },
  ]
  for (const row of rows) safe(`reference row ${row.id}`, () => face.registerFixed(row))
}

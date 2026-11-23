import { describe, expect, it } from 'vitest'
import { approvalAction, isChordKey, questionAction } from '../src/client/keymap.ts'
import type { Focus, KeyInput } from '../src/client/keymap.ts'

const k = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key, ctrl: false, meta: false, alt: false, shift: false, ...extra })

describe('approval key map', () => {
  const a = (key: string, hasAlways: boolean, focus: Focus = 'other', extra: Partial<KeyInput> = {}) => approvalAction(k(key, extra), { hasAlways, focus })

  it('1 allows once, 2 always (when offered), 3 and Esc reject, Enter allows once', () => {
    expect(a('1', true)).toBe('allow')
    expect(a('2', true)).toBe('always')
    expect(a('3', true)).toBe('reject')
    expect(a('Escape', true)).toBe('reject')
    expect(a('Enter', true)).toBe('allow')
  })
  it('without "always": 2 rejects too, 3 and Esc still reject, Enter never becomes always', () => {
    expect(a('1', false)).toBe('allow')
    expect(a('2', false)).toBe('reject')
    expect(a('3', false)).toBe('reject')
    expect(a('Enter', false)).toBe('allow')
    expect(a('Enter', true)).not.toBe('always')
  })
  it('Enter on a focused button is the browser\'s (that button), but digits and Esc still work there', () => {
    expect(a('Enter', true, 'button')).toBeNull()
    expect(a('1', true, 'button')).toBe('allow')
    expect(a('Escape', true, 'button')).toBe('reject')
  })
  it('does nothing in a text field, with Ctrl/Meta/Alt, with Shift+Enter or for other keys', () => {
    expect(a('1', true, 'editable')).toBeNull()
    expect(a('Enter', true, 'editable')).toBeNull()
    for (const m of [{ ctrl: true }, { meta: true }, { alt: true }]) {
      expect(a('1', true, 'other', m)).toBeNull()
      expect(a('Enter', true, 'other', m)).toBeNull()
      expect(a('Escape', true, 'other', m)).toBeNull()
    }
    expect(a('Enter', true, 'other', { shift: true })).toBeNull()
    expect(a('4', true)).toBeNull()
    expect(a('a', true)).toBeNull()
    expect(a('ArrowDown', true)).toBeNull()
  })
})

describe('question key map', () => {
  const q = (key: string, o: { n?: number; textarea?: boolean; focus?: Focus } = {}, extra: Partial<KeyInput> = {}) =>
    questionAction(k(key, extra), { optionCount: o.n ?? 3, hasTextarea: o.textarea ?? true, focus: o.focus ?? 'option' })

  it('digits pick the option, never past the last one', () => {
    expect(q('1')).toEqual({ type: 'option', index: 0 })
    expect(q('3')).toEqual({ type: 'option', index: 2 })
    expect(q('4')).toBeNull()
    expect(q('9', { n: 12 })).toEqual({ type: 'option', index: 8 })
    expect(q('1', { n: 0 })).toBeNull()
  })
  it('arrows move between options, left/right change question', () => {
    expect(q('ArrowDown')).toEqual({ type: 'move', delta: 1 })
    expect(q('ArrowUp')).toEqual({ type: 'move', delta: -1 })
    expect(q('ArrowDown', { n: 0 })).toBeNull()
    expect(q('ArrowLeft')).toEqual({ type: 'prev' })
    expect(q('ArrowRight')).toEqual({ type: 'next' })
  })
  it('Enter confirms, except on a focused button (that button\'s own action)', () => {
    expect(q('Enter')).toEqual({ type: 'confirm' })
    expect(q('Enter', { focus: 'other' })).toEqual({ type: 'confirm' })
    expect(q('Enter', { focus: 'button' })).toBeNull()
  })
  it('Tab goes to the custom answer from an option or the card, not from elsewhere and not without a field', () => {
    expect(q('Tab')).toEqual({ type: 'other' })
    expect(q('Tab', { focus: 'other' })).toEqual({ type: 'other' })
    expect(q('Tab', { focus: 'button' })).toBeNull()
    expect(q('Tab', { textarea: false })).toBeNull()
    expect(q('Tab', {}, { shift: true })).toBeNull()
  })
  it('Ctrl+Backspace skips (only that chord)', () => {
    expect(q('Backspace', {}, { ctrl: true })).toEqual({ type: 'skip' })
    expect(q('Backspace')).toBeNull()
    expect(q('Backspace', {}, { ctrl: true, shift: true })).toBeNull()
    expect(q('Backspace', {}, { meta: true })).toBeNull()
  })
  it('inside the custom answer only Esc is ours: digits, Enter, arrows and Ctrl+Backspace stay the text field\'s', () => {
    const f = { focus: 'editable' as const }
    for (const key of ['1', 'Enter', 'ArrowLeft', 'ArrowDown', 'Tab', 'a']) expect(q(key, f)).toBeNull()
    expect(q('Backspace', f, { ctrl: true })).toBeNull()
    expect(q('Escape', f)).toEqual({ type: 'leaveOther' })
    expect(q('Escape', { ...f, n: 0 })).toBeNull()
  })
  it('modifiers other than the skip chord are ignored', () => {
    for (const m of [{ ctrl: true }, { meta: true }, { alt: true }]) {
      expect(q('1', {}, m)).toBeNull()
      expect(q('ArrowDown', {}, m)).toBeNull()
      expect(q('Enter', {}, m)).toBeNull()
    }
  })
})

describe('repeat-swallowed keys', () => {
  it('are the keys the map can act on', () => {
    for (const key of ['Enter', 'Escape', '1', '9', 'ArrowDown', 'Tab', 'Backspace']) expect(isChordKey(k(key)), key).toBe(true)
    for (const key of ['a', ' ', 'Shift', '0']) expect(isChordKey(k(key)), key).toBe(false)
  })
})

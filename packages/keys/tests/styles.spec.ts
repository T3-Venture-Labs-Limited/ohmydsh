// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CSS } from '../src/client/styles.ts'

describe('stylesheet', () => {
  it('uses theme tokens only: no literal colours', () => {
    expect(CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(CSS).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
  })
  it('hides the hint under 600 px and everything on touch screens, and respects reduced motion', () => {
    expect(CSS).toContain('@media (max-width: 599.98px)')
    expect(CSS).toContain('@media (hover: none) and (pointer: coarse)')
    expect(CSS).toContain('@media (prefers-reduced-motion: no-preference)')
  })
  it('paints the hint and the badges from attributes, inserting no nodes', () => {
    expect(CSS).toContain('content: attr(data-ohmydsh-keys-hint)')
    expect(CSS).toContain('attr(data-ohmydsh-key)')
  })
})

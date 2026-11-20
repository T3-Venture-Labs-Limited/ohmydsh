// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(import.meta.dirname, '../src')
describe('boot path stays light and clean', () => {
  it('the client entry pulls no kit components and no primitives package', () => {
    const entry = readFileSync(resolve(src, 'client/index.tsx'), 'utf8')
    expect(entry).not.toMatch(/from '\.\.\/kit\/index\.ts'/)
    for (const file of readdirSync(resolve(src, 'client'))) {
      expect(readFileSync(resolve(src, 'client', file), 'utf8'), file).not.toMatch(/require\(['"]@deepseek-ai\/dsh-client-ui-primitives/)
    }
  })
  it('the sidebar name is a slot occupant, not a CSS override of the stock wordmark', () => {
    for (const file of readdirSync(resolve(src, 'client'))) {
      expect(readFileSync(resolve(src, 'client', file), 'utf8'), file).not.toMatch(/\[class\*=|brandIdentity|fallbackBrandName|!important/)
    }
  })
})

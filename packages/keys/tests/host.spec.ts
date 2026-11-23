// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
import { GLOBAL_NAME, readConfig } from '../src/shared/config.ts'

function run(config?: unknown): unknown[] {
  const handlers: Record<string, (table: { push(row: unknown): void }) => void> = {}
  apply({ on: (event: string, fn: never) => { handlers[event] = fn; return () => {} } } as never, config)
  const rows: unknown[] = []
  handlers['webserver/index-inject']!({ push: (row) => rows.push(row) })
  return rows
}

describe('host half', () => {
  it('is the keys plugin and needs the web server', () => {
    expect(name).toBe('@t3labs/ohmydsh-keys')
    expect(inject).toEqual(['webServer'])
  })
  it('writes the settings row into the page as a global (defaults: both on)', () => {
    expect(run()).toEqual([{ kind: 'global', name: GLOBAL_NAME, value: { enabled: true, autoFocus: true } }])
  })
  it('passes the configured switches through, and falls back to the defaults on junk', () => {
    expect(run({ enabled: false, autoFocus: false })[0]).toMatchObject({ value: { enabled: false, autoFocus: false } })
    expect(run({ autoFocus: false })[0]).toMatchObject({ value: { enabled: true, autoFocus: false } })
    expect(readConfig('nope')).toEqual({ enabled: true, autoFocus: true })
    expect(readConfig({ enabled: 0, autoFocus: 'no' })).toEqual({ enabled: true, autoFocus: true })
  })
})

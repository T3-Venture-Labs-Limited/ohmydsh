// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { installRegistryFilter } from '../src/host/registry-filter.ts'
import { compareSemver, parseSemver, versionSupported } from '../src/host/version.ts'

function logger() {
  const warns: string[] = []
  const infos: string[] = []
  return { warns, infos, info: (m: string) => { infos.push(m) }, warn: (m: string) => { warns.push(m) } }
}

class FakeRegistry {
  calls = 0
  async snapshot(_o?: unknown) { this.calls += 1; return { skills: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }], complete: true } }
  async list(o?: unknown) { return (await this.snapshot(o)).skills }
  async get(name: string, _o?: unknown) { return { name, content: `body of ${name}` } }
}

describe('registry filter', () => {
  it('hides disabled skills from list, snapshot and get, and restores on dispose', async () => {
    const reg = new FakeRegistry()
    const log = logger()
    const originalList = reg.list
    const h = installRegistryFilter(reg, { logger: log, isDisabled: n => n === 'beta' })
    expect(h.installed).toBe(true)
    expect((await reg.list()).map(s => s.name)).toEqual(['alpha', 'gamma'])
    expect((await reg.snapshot()).skills.map(s => s.name)).toEqual(['alpha', 'gamma'])
    expect((await reg.snapshot()).complete).toBe(true)
    expect(await reg.get('beta')).toBeUndefined()
    expect(await reg.get('alpha')).toMatchObject({ content: 'body of alpha' })
    // raw handle stays unfiltered for the manager page
    expect((await h.raw!.list()).map(s => s.name)).toEqual(['alpha', 'beta', 'gamma'])
    h.dispose()
    expect((await reg.list()).map(s => s.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(reg.list).toBe(originalList)
  })

  it('passes the cwd through so per-workspace state can decide', async () => {
    const reg = new FakeRegistry()
    const seen: (string | undefined)[] = []
    installRegistryFilter(reg, { logger: logger(), isDisabled: (_n, cwd) => { seen.push(cwd); return cwd === '/ws/a' } })
    expect(await reg.list({ cwd: '/ws/a' })).toEqual([])
    expect((await reg.list({ cwd: '/ws/b' })).length).toBe(3)
    expect(seen).toContain('/ws/a')
  })

  it('fails open when the registry shape changed (missing method)', async () => {
    const log = logger()
    const changed = { snapshot: async () => ({ skills: [], complete: true }), list: async () => [] } // no get
    const h = installRegistryFilter(changed, { logger: log, isDisabled: () => true })
    expect(h.installed).toBe(false)
    expect(log.warns.length).toBe(1)
    expect(log.warns[0]).toMatch(/shape changed/)
    expect(await changed.list()).toEqual([])
  })

  it('fails open for a non-object, a frozen instance and a double install', () => {
    const log = logger()
    expect(installRegistryFilter(undefined, { logger: log, isDisabled: () => true }).installed).toBe(false)
    expect(installRegistryFilter(Object.freeze(new FakeRegistry()), { logger: log, isDisabled: () => true }).installed).toBe(false)
    const reg = new FakeRegistry()
    const first = installRegistryFilter(reg, { logger: log, isDisabled: () => false })
    expect(first.installed).toBe(true)
    expect(installRegistryFilter(reg, { logger: log, isDisabled: () => false }).installed).toBe(false)
    first.dispose()
  })

  it('passes results through unfiltered (once-logged) when a result shape drifts at runtime', async () => {
    const log = logger()
    const drift = {
      async snapshot() { return { skills: 'nope' } as never },
      async list() { return { weird: true } as never },
      async get(name: string) { return { name, content: '' } },
    }
    const h = installRegistryFilter(drift, { logger: log, isDisabled: () => true })
    expect(h.installed).toBe(true)
    expect(await drift.list()).toEqual({ weird: true })
    expect((await drift.snapshot() as { skills: unknown }).skills).toBe('nope')
    await drift.list()
    expect(log.warns.filter(w => /unexpected/.test(w)).length).toBe(1)
  })

  it('a throwing isDisabled never hides skills', async () => {
    const reg = new FakeRegistry()
    installRegistryFilter(reg, { logger: logger(), isDisabled: () => { throw new Error('boom') } })
    expect((await reg.list()).length).toBe(3)
    expect(await reg.get('alpha')).toBeDefined()
  })
})

describe('version gate', () => {
  it('accepts the supported rc line and rejects others', () => {
    expect(versionSupported('0.2.2-rc.1')).toBe(true)
    expect(versionSupported('0.2.2-rc.3')).toBe(true)
    expect(versionSupported('0.2.2')).toBe(true)
    expect(versionSupported('0.2.9')).toBe(true)
    expect(versionSupported('0.2.2-rc.0')).toBe(false)
    expect(versionSupported('0.2.1')).toBe(false)
    expect(versionSupported('0.3.0')).toBe(false)
    expect(versionSupported('0.3.0-alpha.1')).toBe(false)
    expect(versionSupported('1.0.0')).toBe(false)
    expect(versionSupported('garbage')).toBe(false)
  })
  it('orders prereleases below releases', () => {
    expect(compareSemver(parseSemver('0.2.2-rc.10')!, parseSemver('0.2.2-rc.9')!)).toBeGreaterThan(0)
    expect(compareSemver(parseSemver('0.2.2-rc.1')!, parseSemver('0.2.2')!)).toBeLessThan(0)
  })
})

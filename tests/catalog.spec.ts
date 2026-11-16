// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolkitCatalog, parseToolkitPage } from '../src/host/catalog.ts'
import { humanName } from '../src/host/api.ts'

const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next })
const item = (slug: string, name: string, logo: string | null) => ({ slug, name, meta: { logo } })

describe('toolkit catalog', () => {
  it('parses names and safe logos, falling back to a prettified slug', () => {
    const { entries, next } = parseToolkitPage(page([item('agent_mail', 'Agent Mail', 'https://logos.composio.dev/api/agent_mail'), item('google_maps', '', 'http://evil.test/x.png'), { name: 'no slug' }], 'abc'))
    expect(entries).toEqual([
      ['agent_mail', { name: 'Agent Mail', logo: 'https://logos.composio.dev/api/agent_mail' }],
      ['google_maps', { name: 'Google Maps', logo: null }],
    ])
    expect(next).toBe('abc')
    expect(parseToolkitPage(null)).toEqual({ entries: [], next: null })
  })
  it('follows the cursor, caches in memory and on disk, and never sends credentials of its own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'co-cat-'))
    const file = join(dir, 'toolkits.json')
    const paths: string[] = []
    const source = { request: (_m: string, path: string) => { paths.push(path); return Promise.resolve(paths.length === 1 ? page([item('a', 'A', null)], 'next') : page([item('b', 'B', 'https://logos.composio.dev/api/b')])) } }
    const catalog = new ToolkitCatalog(source, file)
    const first = await catalog.get()
    expect([...first.keys()]).toEqual(['a', 'b'])
    expect(paths[1]).toContain('cursor=next')
    await catalog.get()
    expect(paths).toHaveLength(2)
    expect(JSON.parse(await readFile(file, 'utf8')).items.b.name).toBe('B')
    // a fresh instance (restart) reads the disk cache without calling the API
    const offline = new ToolkitCatalog({ request: () => Promise.reject(new Error('offline')) }, file)
    expect((await offline.get()).get('b')?.name).toBe('B')
  })
  it('survives an API failure with an empty catalog', async () => {
    const catalog = new ToolkitCatalog({ request: () => Promise.reject(new Error('down')) }, undefined)
    expect((await catalog.get()).size).toBe(0)
  })
})

describe('account display name from connection data', () => {
  it('reads only displayName / user.email / user.name and ignores masked values', () => {
    expect(humanName({ displayName: ' deestax ', access_token: 'secret' })).toBe('deestax')
    expect(humanName({ user: { email: 'a@b.c', name: 'A' } })).toBe('a@b.c')
    expect(humanName({ user: { email: 'REDACTED', name: 'Ann' } })).toBe('Ann')
    expect(humanName({ displayName: '****' })).toBeNull()
    expect(humanName({ access_token: 'x', id: 'U123' })).toBeNull()
    expect(humanName({})).toBeNull()
  })
})

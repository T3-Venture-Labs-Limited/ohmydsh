import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCore } from '../../src/v2/core.js'

describe('v2 core file creation', () => {
  it('a lazy core creates nothing until the database is first used, and close() before use is a no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-lazy-'))
    const core = createCore({ root, lazy: true })
    expect(await readdir(root)).toEqual([])
    await core.close()
    expect(await readdir(root)).toEqual([])
    const again = createCore({ root, lazy: true })
    expect(again.db.listJobs()).toEqual([])
    expect(await readdir(root)).toContain('studio.db')
    await again.close(); await rm(root, { recursive: true, force: true })
  })
})

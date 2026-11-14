// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotebookEvent } from '../src/core/types.ts'
import { NotebookService } from '../src/host/service.ts'
import { resolveSettings } from '../src/host/settings.ts'
import { scopeOfSession } from '../src/host/scope.ts'
import { hasPython, makeCtx, TEST_PYTHON } from './helpers.ts'

const DRIVER = join(import.meta.dirname, '../python/kernel_driver.py')
let dir: string
let services: NotebookService[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nbtest-')); services = [] })
afterEach(async () => { await Promise.all(services.map((s) => s.disposeAll())); rmSync(dir, { recursive: true, force: true }) })

async function setup(mode: 'read-only' | 'danger-full-access' = 'danger-full-access', cfg = {}) {
  const { ctx } = makeCtx(dir, mode)
  const settings = resolveSettings({ python: TEST_PYTHON, autosave: false, ...cfg })
  const service = new NotebookService(ctx, settings, DRIVER)
  services.push(service)
  const scope = await scopeOfSession(ctx, 's1')
  return { service, scope }
}

describe('NotebookDocument (host-owned notebook + kernel)', () => {
  it.skipIf(!hasPython)('creates, edits, runs with live push events, and persists a faithful .ipynb', async () => {
    const { service, scope } = await setup()
    const doc = await service.open(scope, 'a.ipynb', { create: true })
    const events: NotebookEvent[] = []
    doc.subscribe((e) => events.push(e))
    const [first] = doc.cells
    doc.edit({ op: 'source', id: first!.id, source: 'x = 40\nprint("hi")\nx + 2' }, 'agent')
    doc.edit({ op: 'insert', after: first!.id, cell_type: 'markdown', source: '# Notes' }, 'user')
    const report = await doc.run([first!.id], { timeoutS: 30, stopOnError: true })
    expect(report.results[0]?.status).toBe('ok')
    const kinds = events.map((e) => e.t)
    expect(kinds).toContain('cell')
    expect(kinds).toContain('order')
    expect(kinds).toContain('run')
    expect(kinds).toContain('out')
    expect(kinds).toContain('kernel')
    // state is shared with the next run on the same kernel
    const second = doc.edit({ op: 'insert', source: 'x * 2' }, 'agent')[0]!
    const r2 = await doc.run([second], { timeoutS: 30, stopOnError: true })
    expect(r2.results[0]?.status).toBe('ok')
    expect(JSON.stringify(doc.cells.find((c) => c.id === second)?.outputs)).toContain('80')
    await doc.save(scope)
    const onDisk = JSON.parse(readFileSync(join(dir, 'a.ipynb'), 'utf8')) as { nbformat_minor: number; cells: { source: string[]; outputs?: unknown[] }[] }
    expect(onDisk.nbformat_minor).toBe(5)
    expect(onDisk.cells[0]?.source).toEqual(['x = 40\n', 'print("hi")\n', 'x + 2'])
    expect(onDisk.cells[0]?.outputs?.length).toBeGreaterThan(0)
  }, 60_000)

  it.skipIf(!hasPython)('streams stdout appends and clears; errors stop the batch and cancel the rest', async () => {
    const { service, scope } = await setup()
    const doc = await service.open(scope, 'b.ipynb', { create: true })
    const a = doc.cells[0]!.id
    doc.edit({ op: 'source', id: a, source: '1/0' })
    const b = doc.edit({ op: 'insert', source: 'print("never")' })[0]!
    const report = await doc.run([a, b], { timeoutS: 30, stopOnError: true })
    expect(report.results.map((r) => r.status)).toEqual(['error'])
    expect(report.notRun).toContain(b)
    expect(doc.cells.find((c) => c.id === a)?.outputs[0]?.output_type).toBe('error')
  }, 60_000)

  it.skipIf(!hasPython)('interrupts a cell that exceeds its timeout and keeps kernel state', async () => {
    const { service, scope } = await setup()
    const doc = await service.open(scope, 'c.ipynb', { create: true })
    const a = doc.cells[0]!.id
    doc.edit({ op: 'source', id: a, source: 'y = 7' })
    const slow = doc.edit({ op: 'insert', source: 'import time\ntime.sleep(60)' })[0]!
    const after = doc.edit({ op: 'insert', source: 'y' })[0]!
    await doc.run([a], { timeoutS: 30, stopOnError: true })
    const t0 = Date.now()
    const r = await doc.run([slow], { timeoutS: 2, stopOnError: true })
    expect(r.results[0]?.status).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(15_000)
    const r3 = await doc.run([after], { timeoutS: 30, stopOnError: true })
    expect(r3.results[0]?.status).toBe('ok')
    expect(JSON.stringify(doc.cells.find((c) => c.id === after)?.outputs)).toContain('7')
  }, 90_000)

  it('refuses edits and saves in a read-only session', async () => {
    const { service, scope } = await setup('read-only')
    writeFileSync(join(dir, 'r.ipynb'), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }))
    const doc = await service.open(scope, 'r.ipynb')
    expect(() => doc.assertWritable(scope)).toThrow(/read-only/)
    expect(doc.snapshot(scope).readOnly).toBe(true)
  })

  it('confines paths to the workspace', async () => {
    const { service, scope } = await setup()
    await expect(service.open(scope, '../escape.ipynb', { create: true })).rejects.toThrow(/outside the session workspace/)
    await expect(service.open(scope, 'x.txt')).rejects.toThrow(/not an .ipynb/)
  })

  it('detects a file changed on disk: clean docs reload, dirty docs flag a conflict', async () => {
    const { service, scope } = await setup()
    const doc = await service.open(scope, 'd.ipynb', { create: true })
    await doc.save(scope)
    const events: NotebookEvent[] = []
    doc.subscribe((e) => events.push(e))
    const changed = { cells: [{ cell_type: 'markdown', id: 'zz', metadata: {}, source: ['outside'] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(dir, 'd.ipynb'), JSON.stringify(changed, null, 1) + '\n')
    await doc.checkDisk()
    expect(doc.cells[0]?.source).toBe('outside')
    doc.edit({ op: 'source', id: 'zz', source: 'mine' })
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(join(dir, 'd.ipynb'), JSON.stringify({ ...changed, metadata: { a: 1 } }, null, 1) + '\n')
    await doc.checkDisk()
    expect(doc.conflict).toBe(true)
    await expect(doc.save(scope)).rejects.toThrow(/changed on disk/)
    await doc.save(scope, true)
    expect(doc.conflict).toBe(false)
    expect(readFileSync(join(dir, 'd.ipynb'), 'utf8')).toContain('mine')
  })
})

describe('kernel run counter (drives the stale-outputs hint)', () => {
  it.skipIf(!hasPython)('is 0 for a fresh kernel, counts runs, and resets on restart', async () => {
    const { service, scope } = await setup()
    const doc = await service.open(scope, 'k.ipynb', { create: true })
    expect(doc.snapshot(scope).kernel.runs).toBe(0)
    doc.edit({ op: 'source', id: doc.cells[0]!.id, source: '1+1' })
    await doc.run([doc.cells[0]!.id], { timeoutS: 30, stopOnError: true })
    expect(doc.snapshot(scope).kernel.runs).toBe(1)
    await doc.restartKernel()
    // restart keeps the process but empties the namespace
    expect(doc.snapshot(scope).kernel.runs).toBe(0)
    await doc.stopKernel()
    expect(doc.snapshot(scope).kernel.runs).toBe(0)
  }, 60_000)
})

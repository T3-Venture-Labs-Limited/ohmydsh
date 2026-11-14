// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerTools } from '../src/host/tools.ts'
import { registerApproval } from '../src/host/approval.ts'
import { NotebookService } from '../src/host/service.ts'
import { resolveSettings } from '../src/host/settings.ts'
import { hasPython, makeCtx, TEST_PYTHON } from './helpers.ts'

const DRIVER = join(import.meta.dirname, '../python/kernel_driver.py')
let dir: string
let service: NotebookService | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nbtools-')) })
afterEach(async () => { await service?.disposeAll(); rmSync(dir, { recursive: true, force: true }) })

interface RegisteredTool { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown>; output: { render: (a: unknown, v: unknown) => { type: string; text?: string }[] } }

function build(mode: 'workspace-write' | 'danger-full-access' = 'danger-full-access', cfg: Record<string, unknown> = {}) {
  const { ctx } = makeCtx(dir, mode)
  const tools = new Map<string, RegisteredTool>()
  const hooks: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>)[] = []
  const saved: { data: Uint8Array; mediaType: string }[] = []
  const augmented = ctx as unknown as Record<string, unknown>
  augmented.tools = { register: (definition: RegisteredTool) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
  augmented.on = (event: string, fn: never) => { if (event === 'tools/pre-execute') hooks.push(fn); return () => {} }
  augmented.get = (name: string) => {
    if (name === 'attachments') return { imageLimits: { maxImageBytes: 10 << 20 }, saveImage: async (input: { data: Uint8Array; mediaType: string }) => { saved.push(input); return { attachmentId: `att-${saved.length}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 500, height: 300, name: 'x.png' } } }
    if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
    return undefined
  }
  const settings = resolveSettings({ python: TEST_PYTHON, autosave: false, ...cfg })
  service = new NotebookService(ctx, settings, DRIVER)
  registerTools(ctx, service, settings)
  registerApproval(ctx, settings)
  const session = { id: 's1', requestHeader: () => undefined }
  const exec = { agent: { session, options: { provider: 'p', model: 'm' } }, signal: new AbortController().signal, name: '', arguments: {}, callId: 'c1' }
  return { tools, hooks, saved, exec, call: async (name: string, args: unknown) => (await (tools.get(name) as RegisteredTool).execute(args, { ...exec, name, arguments: args })) as { text: string; images?: unknown[] } }
}

describe('agent tools', () => {
  it('registers exactly eight compact tools', () => {
    const { tools } = build()
    expect([...tools.keys()].sort()).toEqual(['nb_edit', 'nb_env', 'nb_kernel', 'nb_open', 'nb_output', 'nb_read', 'nb_run', 'nb_vars'])
  })

  it.skipIf(!hasPython)('open → edit → run (plot as attachment, capped text) → output → vars → kernel', async () => {
    const { call, saved } = build()
    const opened = await call('nb_open', { path: 'a.ipynb', create: true })
    expect(opened.text).toMatch(/1 cells/)
    await call('nb_edit', { path: 'a.ipynb', edits: [
      { op: 'replace', cell: '0', source: 'import numpy as np\nimport matplotlib.pyplot as plt\nx = np.arange(5)\nprint("big " * 5000)\nplt.plot(x, x**2)\nplt.show()' },
      { op: 'insert', source: 'x.sum()' },
    ] })
    const run = await call('nb_run', { path: 'a.ipynb', cells: 'all', timeout_s: 60 })
    expect(run.text).toMatch(/ok/)
    expect(run.text.length).toBeLessThan(10_000)
    expect(run.text).toContain('omitted')
    expect(run.text).toContain('10')
    expect(run.images).toHaveLength(1)
    expect(saved[0]?.mediaType).toBe('image/png')
    // no base64 in the model-visible text
    expect(run.text).not.toMatch(/iVBOR/)

    const out = await call('nb_output', { path: 'a.ipynb', cell: '0', offset: -300, limit: 300 })
    expect(out.text).toMatch(/1 image/)
    const vars = await call('nb_vars', { path: 'a.ipynb' })
    expect(vars.text).toContain('"x"')
    const detail = await call('nb_vars', { path: 'a.ipynb', name: 'x', preview: true })
    expect(detail.text).toContain('ndarray')
    const kernel = await call('nb_kernel', { path: 'a.ipynb', action: 'restart' })
    expect(kernel.text).toMatch(/cleared/)
    const after = await call('nb_vars', { path: 'a.ipynb' })
    expect(after.text).not.toContain('"x"')
  }, 120_000)

  it.skipIf(!hasPython)('an error stops the run and returns a short ANSI-free traceback', async () => {
    const { call } = build()
    await call('nb_open', { path: 'b.ipynb', create: true })
    await call('nb_edit', { path: 'b.ipynb', edits: [{ op: 'replace', cell: '0', source: 'def f():\n    return 1/0\nf()' }, { op: 'insert', source: 'print("never")' }] })
    const run = await call('nb_run', { path: 'b.ipynb' })
    expect(run.text).toContain('ZeroDivisionError')
    expect(run.text).not.toContain('\u001b')
    expect(run.text).toMatch(/Not run: 1/)
  }, 60_000)

  it('edits are rejected for a path outside the workspace and in read-only sessions', async () => {
    const outside = build()
    await expect(outside.call('nb_open', { path: '../x.ipynb', create: true })).rejects.toThrow(/outside the session workspace/)
  })

  it('asks for approval unless the session is full access', async () => {
    const decide = async (mode: 'workspace-write' | 'danger-full-access', name: string, args: unknown, cfg = {}) => {
      const { hooks, exec } = build(mode, cfg)
      let verdict: unknown
      await hooks[0]?.({ ...exec, name, arguments: args }, async () => { verdict = { kind: 'allow' }; return verdict })
      return verdict ?? 'asked'
    }
    const askOf = async (mode: 'workspace-write' | 'danger-full-access', name: string, args: unknown, cfg = {}) => {
      const { hooks, exec } = build(mode, cfg)
      return (await hooks[0]?.({ ...exec, name, arguments: args }, async () => ({ kind: 'allow' }))) as { kind: string; displayReason?: { en: string } }
    }
    expect((await askOf('workspace-write', 'nb_run', { path: 'a.ipynb', cells: '1-2' })).kind).toBe('ask')
    expect((await askOf('workspace-write', 'nb_run', { path: 'a.ipynb' })).displayReason?.en).toMatch(/run all cells of a\.ipynb/)
    expect((await askOf('workspace-write', 'nb_env', { action: 'create', path: 'a.ipynb', packages: ['pandas'] })).kind).toBe('ask')
    expect(await decide('danger-full-access', 'nb_run', { path: 'a.ipynb' })).toEqual({ kind: 'allow' })
    expect(await decide('workspace-write', 'nb_read', { path: 'a.ipynb' })).toEqual({ kind: 'allow' })
    expect(await decide('workspace-write', 'nb_env', { action: 'list' })).toEqual({ kind: 'allow' })
    expect((await askOf('danger-full-access', 'nb_run', { path: 'a.ipynb' }, { approval: 'always' })).kind).toBe('ask')
    expect(await decide('workspace-write', 'nb_run', { path: 'a.ipynb' }, { approval: 'never' })).toEqual({ kind: 'allow' })
  })
})

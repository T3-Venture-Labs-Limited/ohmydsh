// @vitest-environment node
// Regression tests for the security review (NB-1..NB-4).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NotebookService } from '../src/host/service.ts'
import { resolveSettings } from '../src/host/settings.ts'
import { annotate, approveInterpreter, configureTrustStore, createNotebookEnv, discoverInterpreters, inspectPython, minimalEnv, pickDefault } from '../src/host/python.ts'
import { registerTools } from '../src/host/tools.ts'
import { scopeOfSession } from '../src/host/scope.ts'
import { makeCtx } from './helpers.ts'

let dir: string
let service: NotebookService | undefined
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'nbsec-')); await configureTrustStore(undefined) })
afterEach(async () => { await service?.disposeAll(); service = undefined; rmSync(dir, { recursive: true, force: true }) })

/** A fake interpreter that leaves a marker file when anything executes it. */
function plant(path: string, marker: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho "EXECUTED env=$HOME_SECRET" > "${marker}"\nexit 0\n`)
  chmodSync(path, 0o755)
}

/** Lay out a venv's passive markers (pyvenv.cfg + site-packages/ipykernel). */
function fakeVenv(prefix: string, kernel: boolean): void {
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  writeFileSync(join(prefix, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = false\n')
  if (kernel) {
    mkdirSync(join(prefix, 'lib', 'python3.12', 'site-packages', 'ipykernel'), { recursive: true })
    mkdirSync(join(prefix, 'lib', 'python3.12', 'site-packages', 'jupyter_client'), { recursive: true })
  }
}

const noExe = async (): Promise<undefined> => undefined

describe('NB-1: interpreter discovery never executes workspace binaries', () => {
  it('lists a planted .venv/bin/python without running it, and does not trust it', async () => {
    const marker = join(dir, 'pwned.txt')
    plant(join(dir, '.venv', 'bin', 'python'), marker)
    fakeVenv(join(dir, '.venv'), true)
    process.env.HOME_SECRET = 'leaked'
    try {
      const options = await annotate(await discoverInterpreters({ workspaceRoot: dir, notebookDir: dir, resolveExecutable: noExe }))
      const planted = options.find((o) => o.python === join(dir, '.venv', 'bin', 'python'))
      expect(planted).toBeDefined()
      expect(planted?.ready).toBe(true) // detected passively from site-packages
      expect(planted?.trusted).toBe(false)
      expect(pickDefault(options.filter((o) => o.python.startsWith(dir)))).toBeUndefined()
      expect(existsSync(marker)).toBe(false)
    } finally {
      delete process.env.HOME_SECRET
    }
  })

  it('does not run a pin that comes from the notebook file, inside or outside the workspace', async () => {
    const marker = join(dir, 'pwned2.txt')
    const outside = mkdtempSync(join(tmpdir(), 'nbsec-out-'))
    try {
      plant(join(outside, 'python'), marker)
      const options = await annotate(await discoverInterpreters({ workspaceRoot: dir, notebookDir: dir, pinned: join(outside, 'python'), resolveExecutable: noExe }))
      expect(options.find((o) => o.python === join(outside, 'python'))?.trusted).toBe(false)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('treats a symlink that points into the workspace as inside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'nbsec-link-'))
    try {
      plant(join(dir, 'real-python'), join(dir, 'm.txt'))
      mkdirSync(join(outside, 'bin'))
      symlinkSync(join(dir, 'real-python'), join(outside, 'bin', 'python'))
      const options = await discoverInterpreters({ workspaceRoot: dir, notebookDir: dir, configured: undefined, pinned: join(outside, 'bin', 'python'), resolveExecutable: noExe })
      expect(options.find((o) => o.python === join(outside, 'bin', 'python'))?.workspace).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('becomes startable only after an explicit pick, and the pick is dropped when the binary changes', async () => {
    const python = join(dir, '.venv', 'bin', 'python')
    plant(python, join(dir, 'm.txt'))
    fakeVenv(join(dir, '.venv'), true)
    const discover = () => discoverInterpreters({ workspaceRoot: dir, notebookDir: dir, pinned: python, resolveExecutable: noExe })
    expect((await discover()).find((o) => o.python === python)?.trusted).toBe(false)
    await approveInterpreter(python)
    expect((await discover()).find((o) => o.python === python)?.trusted).toBe(true)
    writeFileSync(python, '#!/bin/sh\necho swapped > /dev/null\n# a longer replacement body\n')
    expect((await discover()).find((o) => o.python === python)?.trusted).toBe(false)
  })

  it('operator-controlled settings stay trusted', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'nbsec-cfg-'))
    try {
      plant(join(outside, 'python'), join(outside, 'm.txt'))
      const options = await discoverInterpreters({ workspaceRoot: dir, notebookDir: dir, configured: join(outside, 'python'), resolveExecutable: noExe })
      expect(options.find((o) => o.python === join(outside, 'python'))?.trusted).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('inspectPython is passive: reads pyvenv.cfg and site-packages only', async () => {
    const marker = join(dir, 'm.txt')
    plant(join(dir, 'v1', 'bin', 'python'), marker)
    fakeVenv(join(dir, 'v1'), false)
    expect((await inspectPython(join(dir, 'v1', 'bin', 'python'))).ready).toBe(false)
    fakeVenv(join(dir, 'v1'), true)
    expect((await inspectPython(join(dir, 'v1', 'bin', 'python'))).ready).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it('the nb_env list tool and a kernel start leave a planted interpreter alone', async () => {
    const marker = join(dir, 'pwned3.txt')
    plant(join(dir, '.venv', 'bin', 'python'), marker)
    fakeVenv(join(dir, '.venv'), true)
    const { ctx } = makeCtx(dir, 'workspace-write')
    const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<{ text: string }> }>()
    const augmented = ctx as unknown as Record<string, unknown>
    augmented.tools = { register: (d: { name: string }) => { tools.set(d.name, d as never); return () => {} } }
    augmented.on = () => () => {}
    ;(ctx as unknown as { subprocess: { resolveExecutable: () => Promise<undefined> } }).subprocess.resolveExecutable = noExe
    const settings = resolveSettings({ autosave: false })
    service = new NotebookService(ctx, settings, '/nonexistent/driver.py')
    registerTools(ctx, service, settings)
    const exec = { agent: { session: { id: 's1' } }, signal: new AbortController().signal, name: 'nb_env', arguments: {}, callId: 'c' }
    const listed = await tools.get('nb_env')!.execute({ action: 'list' }, exec)
    expect(listed.text).toContain(join(dir, '.venv', 'bin', 'python'))
    expect(listed.text).toContain('ready')
    expect(listed.text).toContain('NOT TRUSTED')
    // The sidecar start resolves its interpreter the same way: the planted one must be refused, not run.
    await tools.get('nb_open')!.execute({ path: 'a.ipynb', create: true }, { ...exec, name: 'nb_open' })
    await tools.get('nb_edit')!.execute({ path: 'a.ipynb', edits: [{ op: 'replace', cell: '0', source: 'print(1)' }] }, { ...exec, name: 'nb_edit' })
    const run = await tools.get('nb_run')!.execute({ path: 'a.ipynb', cells: 'all' }, { ...exec, name: 'nb_run' })
    expect(run.text).toMatch(/ERROR/) // the cell did not run
    const doc = await service.existing(await scopeOfSession(ctx, 's1'), 'a.ipynb')
    expect(doc?.kernel.info.status).not.toBe('idle')
    expect(existsSync(marker)).toBe(false)
  })

  it('creating an environment never runs an existing, untrusted .venv through uv', async () => {
    const marker = join(dir, 'uv-ran.txt')
    plant(join(dir, '.venv', 'bin', 'python'), join(dir, 'py-ran.txt'))
    const uv = join(dir, 'fake-uv')
    writeFileSync(uv, `#!/bin/sh\necho "$@" > "${marker}"\n`)
    chmodSync(uv, 0o755)
    const made = await createNotebookEnv(uv, dir, ['pandas'])
    expect(made.ok).toBe(false)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(dir, 'py-ran.txt'))).toBe(false)
  })

  it('helper processes get a minimal environment, not the host secrets', () => {
    const env = minimalEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk-x', AWS_SECRET_ACCESS_KEY: 'y', GITHUB_TOKEN: 'z', LANG: 'C', UV_INDEX_URL: 'u' })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'UV_INDEX_URL'])
  })
})


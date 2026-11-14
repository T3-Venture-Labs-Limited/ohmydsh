/**
 * Interpreter discovery and the "create notebook environment" helper.
 *
 * Order of precedence for a notebook's default interpreter:
 *   1. the interpreter pinned in the notebook (metadata.dsh_notebook.python),
 *   2. $DSH_NOTEBOOK_PYTHON, 3. the plugin Config `python`,
 *   4. a project virtualenv (`.venv` / `venv`, searched from the notebook's folder up to the workspace root),
 *   5. $VIRTUAL_ENV, 6. user venv folders and conda environments, 7. python3 / python on PATH.
 * The first TRUSTED candidate that has ipykernel and jupyter_client wins; if none does, the first trusted one is
 * used and the kernel start reports the missing packages with an install hint.
 *
 * Security (NB-1): discovery never executes a candidate. "Has ipykernel" is a passive filesystem check
 * (`pyvenv.cfg` + `site-packages/ipykernel`). A candidate that lives inside the workspace, or that a notebook file
 * pins, is UNTRUSTED: it is listed, but nothing starts it until the user explicitly picks it in the UI or the
 * agent's `nb_env use` passes approval.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import type { InterpreterOption } from '../core/types.ts'

const IS_WINDOWS = process.platform === 'win32'
const PYTHON_IN_VENV = IS_WINDOWS ? join('Scripts', 'python.exe') : join('bin', 'python')

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Environment handed to helper processes we spawn (uv): an allowlist, never the host's full environment. */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z]+|TMPDIR|TEMP|TMP|SYSTEMROOT|COMSPEC|PATHEXT|XDG_[A-Z_]+|UV_[A-Z_]+|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy)$/
export function minimalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOW.test(key) && !/(TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)/i.test(key)) env[key] = value
  }
  return env
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 << 20, env: minimalEnv(), windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
      done({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function isDir(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

/** Parse the `key = value` lines of a `pyvenv.cfg`. */
export async function readPyvenvCfg(prefix: string): Promise<Record<string, string> | undefined> {
  let text: string
  try { text = await readFile(join(prefix, 'pyvenv.cfg'), 'utf8') } catch { return undefined }
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim()
  }
  return out
}

async function sitePackageDirs(prefix: string): Promise<string[]> {
  const dirs: string[] = [join(prefix, 'Lib', 'site-packages')]
  for (const lib of ['lib', 'lib64']) {
    try {
      for (const entry of await readdir(join(prefix, lib))) {
        if (entry.startsWith('python')) dirs.push(join(prefix, lib, entry, 'site-packages'), join(prefix, lib, entry, 'dist-packages'))
      }
    } catch { /* no such lib dir */ }
  }
  return dirs
}

/**
 * Passive readiness check: does the environment this interpreter belongs to contain ipykernel and jupyter_client?
 * Only stats and reads `pyvenv.cfg` and directory entries; the interpreter itself is never run.
 */
export async function inspectPython(python: string): Promise<{ ready: boolean }> {
  const prefixes = new Set<string>([dirname(dirname(python)), dirname(python)])
  const cfg = await readPyvenvCfg(dirname(dirname(python)))
  if (cfg?.['include-system-site-packages'] === 'true' && cfg.home !== undefined && cfg.home !== '') prefixes.add(dirname(cfg.home))
  const have = { ipykernel: false, jupyter_client: false }
  for (const prefix of prefixes) {
    for (const dir of await sitePackageDirs(prefix)) {
      if (!have.ipykernel && await isDir(join(dir, 'ipykernel'))) have.ipykernel = true
      if (!have.jupyter_client && await isDir(join(dir, 'jupyter_client'))) have.jupyter_client = true
    }
  }
  return { ready: have.ipykernel && have.jupyter_client }
}

/** Is `path` (lexically, or after resolving symlinks) inside `root`? A path that cannot be resolved counts as inside (fail closed). */
export async function insideWorkspace(path: string, root: string): Promise<boolean> {
  const within = (p: string, r: string): boolean => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
  const lexical = resolve(path)
  const rootLex = resolve(root)
  if (within(lexical, rootLex)) return true
  try {
    const rootReal = await realpath(rootLex)
    if (within(lexical, rootReal)) return true
    return within(await realpath(lexical), rootReal)
  } catch {
    return true
  }
}

export interface DiscoverInput {
  /** Workspace root (session cwd). */
  workspaceRoot: string
  /** Directory of the notebook file. */
  notebookDir: string
  pinned?: string | undefined
  /** The user (or an approved agent call) explicitly chose `pinned` in this session. A pin read from a notebook file is not. */
  pinnedTrusted?: boolean | undefined
  configured?: string | undefined
  resolveExecutable: (name: string) => Promise<string | undefined>
}

/**
 * Interpreters the user explicitly picked in the UI (or an approved agent `nb_env use|create`). Remembered as
 * `path -> "realpath|size|mtime"` of what was picked, so a later symlink swap or a replaced binary (for example a
 * `git pull` into the workspace) makes the entry stop matching and the user has to pick it again. Persisted when
 * {@link configureTrustStore} was given a directory.
 */
async function signature(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path)
    const info = await stat(real)
    return `${real}|${info.size}|${Math.floor(info.mtimeMs)}`
  } catch { return undefined }
}

const approved = new Map<string, string>()
let trustFile: string | undefined

export async function configureTrustStore(dir: string | undefined): Promise<void> {
  approved.clear()
  trustFile = dir === undefined ? undefined : join(dir, 'trusted-interpreters.json')
  if (trustFile === undefined) return
  try {
    const data = JSON.parse(await readFile(trustFile, 'utf8')) as Record<string, unknown>
    for (const [path, real] of Object.entries(data)) if (typeof real === 'string') approved.set(path, real)
  } catch { /* nothing remembered yet */ }
}

export async function approveInterpreter(python: string): Promise<void> {
  if (python === '') return
  const path = resolve(python)
  const sig = await signature(path)
  if (sig === undefined) return
  approved.set(path, sig)
  if (trustFile === undefined) return
  try {
    await mkdir(dirname(trustFile), { recursive: true, mode: 0o700 })
    await writeFile(trustFile, JSON.stringify(Object.fromEntries(approved)), { mode: 0o600 })
  } catch { /* trust still holds for this process */ }
}

export async function isApproved(python: string): Promise<boolean> {
  const path = resolve(python)
  const remembered = approved.get(path)
  if (remembered === undefined) return false
  return (await signature(path)) === remembered
}

/**
 * Every candidate interpreter, best first, de-duplicated. `ready` is filled in by {@link annotate}.
 * `trusted` says whether the plugin may start it without asking. Trusted: the interpreter the user explicitly picked,
 * the operator's own settings (`DSH_NOTEBOOK_PYTHON`, plugin `python`), and anything the workspace cannot have
 * planted (user venv folders, conda, PATH, `$VIRTUAL_ENV`) while it lies outside the workspace. Untrusted: any
 * candidate inside the workspace, and a pin read from a notebook file.
 */
export async function discoverInterpreters(input: DiscoverInput): Promise<InterpreterOption[]> {
  const found: InterpreterOption[] = []
  const seen = new Map<string, InterpreterOption>()
  const add = async (python: string | undefined, label: string, kind: InterpreterOption['kind'], operator = false): Promise<void> => {
    if (python === undefined || python === '') return
    const real = resolve(python)
    const inWorkspace = await insideWorkspace(real, input.workspaceRoot)
    const trusted = operator || !inWorkspace || (await isApproved(real))
    const earlier = seen.get(real)
    if (earlier !== undefined) {
      if (trusted) earlier.trusted = true // listed again by a source the workspace cannot control
      return
    }
    if (!(await exists(real))) return
    const option: InterpreterOption = { python: real, label, kind, trusted, workspace: inWorkspace }
    seen.set(real, option)
    found.push(option)
  }
  if (input.pinned !== undefined && input.pinned !== '') {
    // Pins from a notebook file are attacker-controllable (any absolute path): trusted only once the user picked them.
    const real = resolve(input.pinned)
    const wasApproved = input.pinnedTrusted === true || (await isApproved(real))
    await add(real, 'Pinned in this notebook', 'config', wasApproved)
    const pin = seen.get(real)
    if (pin !== undefined) pin.trusted = wasApproved
    // A pin may only become trusted later through a non-workspace source, which `add` handles via `earlier`.
  }
  await add(process.env.DSH_NOTEBOOK_PYTHON, 'DSH_NOTEBOOK_PYTHON', 'env', true)
  await add(input.configured, 'Plugin setting', 'config', true)
  // Project virtualenvs, from the notebook folder up to the workspace root. Listed so the user can pick one; never started on their own.
  const root = resolve(input.workspaceRoot)
  let dir = resolve(input.notebookDir)
  for (let depth = 0; depth < 12; depth++) {
    for (const name of ['.venv', 'venv']) await add(join(dir, name, PYTHON_IN_VENV), `${relative(root, join(dir, name))} (project)`, 'project')
    if (dir === root || dirname(dir) === dir || !dir.startsWith(root + sep)) break
    dir = dirname(dir)
  }
  if (process.env.VIRTUAL_ENV) await add(join(process.env.VIRTUAL_ENV, PYTHON_IN_VENV), `${process.env.VIRTUAL_ENV} ($VIRTUAL_ENV)`, 'venv')
  const home = homedir()
  for (const base of [join(home, '.venvs'), join(home, '.virtualenvs'), join(home, '.local', 'share', 'virtualenvs')]) {
    try {
      for (const entry of await readdir(base)) await add(join(base, entry, PYTHON_IN_VENV), `${entry} (${base.replace(home, '~')})`, 'venv')
    } catch { /* folder absent */ }
  }
  for (const file of [join(home, '.conda', 'environments.txt'), join(home, '.anaconda', 'environments.txt')]) {
    try {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        const env = line.trim()
        if (env !== '') await add(IS_WINDOWS ? join(env, 'python.exe') : join(env, 'bin', 'python'), `conda: ${env.split(sep).pop() ?? env}`, 'conda')
      }
    } catch { /* no conda */ }
  }
  for (const name of ['python3', 'python']) await add(await input.resolveExecutable(name), `${name} on PATH`, 'system')
  return found
}

function relative(root: string, path: string): string {
  return path.startsWith(root + sep) ? path.slice(root.length + 1) : path
}

/** Check every candidate (passively, in parallel) for ipykernel + jupyter_client. */
export async function annotate(options: InterpreterOption[]): Promise<InterpreterOption[]> {
  await Promise.all(options.map(async (option) => { option.ready = (await inspectPython(option.python)).ready }))
  return options
}

/** The interpreter a notebook starts with: the first trusted candidate with ipykernel, else the first trusted one. */
export function pickDefault(options: InterpreterOption[]): InterpreterOption | undefined {
  const trusted = options.filter((o) => o.trusted === true)
  return trusted.find((o) => o.ready === true) ?? trusted[0]
}

export const INSTALL_HINT = (python: string): string =>
  `This interpreter cannot import ipykernel and jupyter_client. Install them with: uv pip install --python "${python}" ipykernel jupyter_client — or use "Create notebook environment".`

/** Find `uv` on PATH (or next to common install locations). */
export async function findUv(resolveExecutable: (name: string) => Promise<string | undefined>): Promise<string | undefined> {
  const viaPath = await resolveExecutable('uv')
  if (viaPath !== undefined) return viaPath
  for (const guess of [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/usr/bin/uv']) {
    if (await exists(guess)) return guess
  }
  return undefined
}

export interface CreateEnvResult { ok: boolean; python?: string; message: string }

/**
 * Create `<dir>/.venv` with uv and install the kernel packages (plus any extras).
 * Never touches an existing environment: if `<dir>/.venv` exists, only the missing kernel packages are installed.
 */
export async function createNotebookEnv(
  uv: string,
  dir: string,
  extras: string[],
): Promise<CreateEnvResult> {
  const venv = join(dir, '.venv')
  const python = join(venv, PYTHON_IN_VENV)
  const clean = extras.filter((p) => /^[A-Za-z0-9][A-Za-z0-9._\[\],<>=!~ -]*$/.test(p))
  if (await exists(python)) {
    // `uv pip install --python <existing>` starts that interpreter: never do it for one the user has not trusted.
    if (!(await isApproved(python))) return { ok: false, message: `An environment already exists at ${venv}. The plugin will not run it until you pick it in the Python environment menu (it may have come from the repository). Pick it, then install packages into it yourself.` }
  } else {
    const made = await run(uv, ['venv', venv], 180_000)
    if (made.code !== 0) return { ok: false, message: `uv venv failed: ${(made.stderr || made.stdout).trim().slice(-600)}` }
  }
  const installed = await run(uv, ['pip', 'install', '--python', python, 'ipykernel', 'jupyter_client', ...clean], 900_000)
  if (installed.code !== 0) return { ok: false, message: `uv pip install failed: ${(installed.stderr || installed.stdout).trim().slice(-600)}` }
  return { ok: true, python, message: `Created ${venv}` }
}

export { delimiter }

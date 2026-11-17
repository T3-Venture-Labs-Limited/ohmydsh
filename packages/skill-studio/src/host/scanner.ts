// Own filesystem scan of every skill root, mirroring the DSH filesystem provider's discovery, but keeping what the
// registry drops: shadowed duplicates and files it silently ignores (invalid frontmatter).
import { createHash } from 'node:crypto'
import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve, basename, sep } from 'node:path'
import { validateSkillText, type Issue } from './frontmatter.ts'

export type RootSource = 'project-dsh' | 'project-agents' | 'custom' | 'user-dsh' | 'user-agents'

export interface ScanRoot {
  path: string
  source: RootSource
  /** Same ranks as the DSH filesystem provider: lower wins within one provider. */
  rank: number
  skipSystem?: boolean
}

export const RANKS: Record<RootSource, number> = { 'project-dsh': 100, 'project-agents': 200, custom: 300, 'user-dsh': 400, 'user-agents': 500 }

export interface ScanEntry {
  /** Stable id: the displayed file path. */
  id: string
  root: string
  source: RootSource
  rank: number
  dirName: string
  layout: 'folder' | 'flat'
  /** Displayed path of the skill file. */
  path: string
  /** Resolved path after following symlinks. */
  realPath: string
  /** The skill folder (or its file) is itself a symlink. */
  symlink: boolean
  writable: boolean
  readOnlyReason?: 'system' | 'permission' | 'outside-root'
  /**
   * The real file lies outside the scanned root's own real path (a symlink leads out of it). Such an entry is never
   * writable (SS-1): a cloned repository must not be able to point `.agents/skills/x/SKILL.md` at `~/.bashrc`.
   */
  outsideRoot: boolean
  /** Safe to show or copy the file's text: inside its root, or the root is the user's own (user-dsh / user-agents). */
  contentReadable: boolean
  size: number
  mtimeMs: number
  wouldLoad: boolean
  name?: string
  description?: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  issues: Issue[]
}

export interface RootInputs {
  /** Working directory whose project root contributes `.dsh/skills` and `.agents/skills`. */
  cwd?: string
  /** `~/.dsh`-style home; DSH_HOME in the dev harness. */
  dshHome: string
  /** `~` of the agents ecosystem; skills live in `<agentsHome>/.agents/skills`. */
  agentsHome: string
  customDirs?: readonly string[]
}

/** Nearest ancestor with a `.git`, otherwise the directory itself (same rule as the filesystem provider). */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    try { await access(join(current, '.git')); return current } catch { /* keep walking */ }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

export async function computeRoots(input: RootInputs): Promise<ScanRoot[]> {
  const roots: ScanRoot[] = []
  if (input.cwd !== undefined) {
    const project = await findProjectRoot(input.cwd)
    roots.push({ path: join(project, '.dsh/skills'), source: 'project-dsh', rank: RANKS['project-dsh'] }, { path: join(project, '.agents/skills'), source: 'project-agents', rank: RANKS['project-agents'] })
  }
  for (const dir of input.customDirs ?? []) roots.push({ path: dir, source: 'custom', rank: RANKS.custom })
  roots.push(
    { path: join(input.dshHome, 'skills'), source: 'user-dsh', rank: RANKS['user-dsh'], skipSystem: true },
    { path: join(input.agentsHome, '.agents/skills'), source: 'user-agents', rank: RANKS['user-agents'] },
  )
  return roots
}

const cache = new Map<string, { mtimeMs: number; size: number; entry: Omit<ScanEntry, 'id' | 'root' | 'source' | 'rank' | 'dirName' | 'layout' | 'path' | 'symlink' | 'outsideRoot' | 'contentReadable'> }>()

async function isWritable(realFile: string): Promise<{ writable: boolean; reason?: 'system' | 'permission' }> {
  if (realFile.startsWith('/usr/') || realFile.startsWith('/opt/')) return { writable: false, reason: 'system' }
  try {
    await access(realFile, constants.W_OK)
    await access(dirname(realFile), constants.W_OK)
    return { writable: true }
  } catch {
    return { writable: false, reason: 'permission' }
  }
}

async function readEntry(file: string, dirName: string): Promise<Pick<ScanEntry, 'realPath' | 'writable' | 'size' | 'mtimeMs' | 'wouldLoad' | 'name' | 'description' | 'whenToUse' | 'modelInvocable' | 'userInvocable' | 'issues'> & { readOnlyReason?: 'system' | 'permission' | 'outside-root' }> {
  const real = await realpath(file)
  const info = await stat(real)
  const hit = cache.get(real)
  if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    // Validation depends on the folder name, so only reuse when the name check cannot have changed.
    const again = await isWritable(real)
    return { ...hit.entry, writable: again.writable, ...(again.reason === undefined ? {} : { readOnlyReason: again.reason }) }
  }
  const raw = await readFile(real, 'utf8')
  const v = validateSkillText(raw, dirName)
  const w = await isWritable(real)
  const entry = {
    realPath: real, writable: w.writable, ...(w.reason === undefined ? {} : { readOnlyReason: w.reason }),
    size: info.size, mtimeMs: info.mtimeMs, wouldLoad: v.wouldLoad,
    ...(v.name === undefined ? {} : { name: v.name }), ...(v.description === undefined ? {} : { description: v.description }),
    ...(v.whenToUse === undefined ? {} : { whenToUse: v.whenToUse }),
    modelInvocable: v.modelInvocable, userInvocable: v.userInvocable, issues: v.issues,
  }
  cache.set(real, { mtimeMs: info.mtimeMs, size: info.size, entry })
  return entry
}

/** `child` is `parent` or lies below it (both already real paths). */
export function isInside(child: string, parent: string): boolean {
  const base = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(base)
}

const USER_SOURCES: readonly RootSource[] = ['user-dsh', 'user-agents']

/** Fold the realpath-containment verdict into an entry (SS-1). */
function contain(e: Omit<ScanEntry, 'outsideRoot' | 'contentReadable'>, rootReal: string, source: RootSource): ScanEntry {
  const inside = isInside(e.realPath, rootReal)
  if (inside) return { ...e, outsideRoot: false, contentReadable: true }
  return {
    ...e, outsideRoot: true, writable: false,
    readOnlyReason: e.readOnlyReason === 'system' ? 'system' : 'outside-root',
    contentReadable: USER_SOURCES.includes(source),
  }
}

export async function scanRoot(root: ScanRoot): Promise<ScanEntry[]> {
  let rootReal: string
  try { rootReal = await realpath(root.path) } catch { return [] }
  let children
  try { children = await readdir(root.path, { withFileTypes: true }) } catch { return [] }
  const out: ScanEntry[] = []
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem === true && child.name === '.system') continue
    if (child.name.startsWith('.') && !child.isDirectory() && !child.isSymbolicLink()) continue
    const full = join(root.path, child.name)
    let kind: 'dir' | 'file' | undefined
    let symlink = false
    if (child.isDirectory()) kind = 'dir'
    else if (child.isFile()) kind = 'file'
    else if (child.isSymbolicLink()) {
      symlink = true
      try { const s = await stat(full); kind = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : undefined } catch { kind = undefined }
    }
    if (kind === undefined) continue
    try {
      if (kind === 'dir') {
        const file = join(full, 'SKILL.md')
        try { await stat(file) } catch { continue }
        if (!symlink) symlink = (await lstat(file)).isSymbolicLink()
        const e = await readEntry(file, child.name)
        out.push(contain({ id: file, root: root.path, source: root.source, rank: root.rank, dirName: child.name, layout: 'folder', path: file, symlink, ...e }, rootReal, root.source))
      } else if (child.name.endsWith('.md')) {
        const stem = basename(child.name, '.md')
        const e = await readEntry(full, stem)
        out.push(contain({ id: full, root: root.path, source: root.source, rank: root.rank, dirName: stem, layout: 'flat', path: full, symlink, ...e }, rootReal, root.source))
      }
    } catch { /* unreadable entry: skip, like the provider's per-entry tolerance */ }
  }
  return out
}

export async function scanRoots(roots: readonly ScanRoot[]): Promise<ScanEntry[]> {
  const all = await Promise.all(roots.map(scanRoot))
  return all.flat()
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

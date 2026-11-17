// The only module that writes skill files. Everything else (disable, scan, usage) is read-only with respect to skill roots.
// Guarantees: optimistic lock on the file's sha256, backup before overwrite, atomic temp+rename in the target's own
// directory, confinement to scanned skill files / the allowed creation roots, refusal of read-only targets.
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { isInside, sha256, type ScanEntry } from './scanner.ts'
import { SKILL_NAME, validateSkillText, renderSkillTemplate, type Issue } from './frontmatter.ts'

export class WriteRefusal extends Error {
  constructor(readonly code: 'not-found' | 'read-only' | 'outside-root' | 'conflict' | 'invalid' | 'exists' | 'bad-name' | 'bad-target', message: string, readonly issues?: Issue[]) {
    super(message)
  }
}

export interface WriterOptions {
  backupsDir: string
  now?: () => Date
}

const stamp = (d: Date): string => d.toISOString().replace(/[:.]/g, '-')

async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${String(process.pid)}.${String(Date.now())}.tmp`)
  let mode = 0o644
  try { mode = (await stat(target)).mode & 0o777 } catch { /* new file */ }
  try {
    await writeFile(tmp, content, { mode, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY })
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Copy the current file into `<backups>/<skill>/<timestamp>-<sha8>.md`; returns the backup path. */
export async function backupFile(opts: WriterOptions, file: string, skillName: string, current: Buffer): Promise<string> {
  const dir = join(opts.backupsDir, skillName.replace(/[^a-z0-9._-]/gi, '_'))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const out = join(dir, `${stamp((opts.now ?? (() => new Date()))())}-${sha256(current).slice(0, 8)}.md`)
  await writeFile(out, current, { mode: 0o600 })
  void file
  return out
}

export interface SaveResult { sha256: string; backup: string; mtimeMs: number; issues: Issue[]; wouldLoad: boolean }

/**
 * SS-1: the write target must still be the regular file the scan saw, inside the root's own real path. Called right
 * before the backup and again right before the rename, so a symlink swapped in after the scan (or between the two
 * calls) is refused. Returns the verified real path.
 */
export async function verifyContained(entry: ScanEntry): Promise<string> {
  if (entry.outsideRoot) throw new WriteRefusal('outside-root', 'This skill file is a symlink that leads outside its skill folder, so it is read-only. Duplicate it into an editable root instead.')
  let rootReal: string
  let now: string
  try {
    rootReal = await realpath(entry.root)
    now = await realpath(entry.path)
  } catch { throw new WriteRefusal('not-found', 'The skill file no longer exists.') }
  if (now !== entry.realPath) throw new WriteRefusal('conflict', 'The skill file was replaced or re-linked since it was scanned. Reload the page and try again.')
  if (!isInside(now, rootReal)) throw new WriteRefusal('outside-root', 'The skill file now resolves outside its skill folder; refusing to write through it.')
  const info = await lstat(now)
  if (!info.isFile()) throw new WriteRefusal('bad-target', 'The skill path is not a regular file.')
  return now
}

/** Overwrite an existing, scanned, writable skill file. */
export async function saveSkill(opts: WriterOptions, entry: ScanEntry, content: string, baseSha256: string): Promise<SaveResult> {
  if (!entry.writable) {
    throw new WriteRefusal('read-only', entry.readOnlyReason === 'system'
      ? 'This skill lives in a read-only system location. Duplicate it into an editable root instead.'
      : 'This skill file is not writable by DSH.')
  }
  const target = await verifyContained(entry)
  let current: Buffer
  try { current = await readFile(target) } catch { throw new WriteRefusal('not-found', 'The skill file no longer exists.') }
  if (sha256(current) !== baseSha256) throw new WriteRefusal('conflict', 'The file changed on disk since you opened it. Reload it, then re-apply your edit.')
  const v = validateSkillText(content, entry.dirName)
  const errors = v.issues.filter(i => i.level === 'error')
  if (errors.length > 0) throw new WriteRefusal('invalid', 'The skill has errors that would stop DSH loading it; fix them before saving.', v.issues)
  const normalized = content.endsWith('\n') ? content : `${content}\n`
  const backup = await backupFile(opts, target, entry.dirName, current)
  await verifyContained(entry) // again, as late as possible: narrows the window between check and rename
  await atomicWrite(target, normalized)
  const info = await stat(target)
  return { sha256: sha256(normalized), backup, mtimeMs: info.mtimeMs, issues: v.issues, wouldLoad: v.wouldLoad }
}

export interface CreateInput { name: string; description: string; body?: string; root: string }
export interface CreateResult { path: string; sha256: string; issues: Issue[] }

/** Create `<root>/<name>/SKILL.md`. `root` must be one of the caller-vetted allowed roots. */
export async function createSkill(input: CreateInput, allowedRoots: readonly string[]): Promise<CreateResult> {
  if (!SKILL_NAME.test(input.name) || input.name.length > 64) throw new WriteRefusal('bad-name', 'Name must be lowercase kebab-case (a-z, 0-9, single hyphens), up to 64 characters.')
  const root = resolve(input.root)
  if (!allowedRoots.map(r => resolve(r)).includes(root)) throw new WriteRefusal('bad-target', 'That location is not an allowed skill root.')
  const dir = resolve(root, input.name)
  if (dirname(dir) !== root || !(dir + sep).startsWith(root + sep)) throw new WriteRefusal('bad-name', 'Invalid skill name.')
  const description = input.description.trim()
  if (description.length === 0) throw new WriteRefusal('invalid', 'A description is required.', [{ level: 'error', code: 'description-missing', message: 'A description is required.' }])
  const text = renderSkillTemplate({ name: input.name, description, ...(input.body === undefined ? {} : { body: input.body }) })
  const v = validateSkillText(text, input.name)
  if (!v.wouldLoad) throw new WriteRefusal('invalid', 'The generated skill is not valid.', v.issues)
  try { await stat(dir); throw new WriteRefusal('exists', `A skill folder named "${input.name}" already exists in that location.`) } catch (error) {
    if (error instanceof WriteRefusal) throw error
  }
  await mkdir(dir, { recursive: true, mode: 0o755 })
  const file = join(dir, 'SKILL.md')
  try { await atomicWrite(file, text) } catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
  return { path: file, sha256: sha256(text), issues: v.issues }
}

/** Copy a skill's folder file into another root as an editable duplicate (SKILL.md only; resources stay referenced by the original). */
export async function duplicateSkill(entry: ScanEntry, name: string, root: string, allowedRoots: readonly string[]): Promise<CreateResult> {
  if (!entry.contentReadable) throw new WriteRefusal('outside-root', 'This skill file is a symlink that leads outside its skill folder; its content is not copied.')
  const text = await readFile(entry.realPath, 'utf8')
  const renamed = text.replace(/^(---\r?\n[\s\S]*?\bname:\s*)([^\r\n]+)/, `$1${name}`)
  const v = validateSkillText(renamed, name)
  return createSkill({ name, description: v.description ?? name, body: renamed.slice(renamed.indexOf('\n---', 3) + 5), root }, allowedRoots).then(async (res) => {
    await atomicWrite(res.path, renamed.endsWith('\n') ? renamed : `${renamed}\n`)
    void copyFile
    return { ...res, sha256: sha256(renamed) }
  })
}

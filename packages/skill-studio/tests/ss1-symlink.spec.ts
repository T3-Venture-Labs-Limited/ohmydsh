// @vitest-environment node
// SS-1 regression tests: a symlinked SKILL.md (file or directory) must never be written through, nor read back to the
// page, and a swap between scan and save must be refused.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { computeRoots, scanRoot, scanRoots, sha256 } from '../src/host/scanner.ts'
import { buildRows } from '../src/host/model.ts'
import { emptySettings } from '../src/host/store.ts'
import { duplicateSkill, saveSkill, verifyContained } from '../src/host/writer.ts'

const base = join(import.meta.dirname, '..', '.tmp', 'tests')
mkdirSync(base, { recursive: true })
let dir: string
beforeEach(() => { dir = mkdtempSync(join(base, 'ss1-')) })

const skill = (name: string, body = 'body') => `---\nname: ${name}\ndescription: Does ${name} things. Use when asked.\n---\n${body}\n`
const opts = () => ({ backupsDir: join(dir, 'backups') })
const EVIL = skill('evil', 'OVERWRITTEN')

describe('SS-1: symlinked SKILL.md in a project root', () => {
  it('reviewer PoC: SKILL.md -> victim file is listed read-only and the victim is untouched', async () => {
    const root = join(dir, 'root'); mkdirSync(join(root, 'evil'), { recursive: true })
    const victim = join(dir, 'outside', 'victim.md'); mkdirSync(join(dir, 'outside'))
    writeFileSync(victim, 'PRECIOUS FILE\n')
    symlinkSync(victim, join(root, 'evil', 'SKILL.md'))
    const [e] = await scanRoot({ path: root, source: 'project-agents', rank: 200 })
    expect(e).toBeDefined()
    expect(e!.outsideRoot).toBe(true)
    expect(e!.writable).toBe(false)
    expect(e!.readOnlyReason).toBe('outside-root')
    expect(e!.contentReadable).toBe(false)
    await expect(saveSkill(opts(), e!, EVIL, sha256(readFileSync(victim)))).rejects.toMatchObject({ code: 'read-only' })
    expect(readFileSync(victim, 'utf8')).toBe('PRECIOUS FILE\n')
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('a symlinked skill DIRECTORY pointing out of the root is read-only too', async () => {
    const root = join(dir, 'root'); mkdirSync(root)
    mkdirSync(join(dir, 'elsewhere', 'lk'), { recursive: true })
    const real = join(dir, 'elsewhere', 'lk', 'SKILL.md'); writeFileSync(real, skill('lk'))
    symlinkSync(join(dir, 'elsewhere', 'lk'), join(root, 'lk'))
    const [e] = await scanRoot({ path: root, source: 'project-dsh', rank: 100 })
    expect(e!.outsideRoot).toBe(true)
    expect(e!.writable).toBe(false)
    await expect(saveSkill(opts(), e!, skill('lk', 'x'), sha256(readFileSync(real)))).rejects.toMatchObject({ code: 'read-only' })
    expect(readFileSync(real, 'utf8')).toBe(skill('lk'))
  })

  it('a symlink that stays inside the root is still editable', async () => {
    const root = join(dir, 'root'); mkdirSync(join(root, 'real'), { recursive: true })
    const real = join(root, 'real', 'SKILL.md'); writeFileSync(real, skill('real'))
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    const entries = await scanRoot({ path: root, source: 'project-agents', rank: 200 })
    const alias = entries.find((e) => e.dirName === 'alias')!
    expect(alias.outsideRoot).toBe(false)
    expect(alias.writable).toBe(true)
    await saveSkill(opts(), alias, skill('real', 'edited'), sha256(readFileSync(real)))
    expect(readFileSync(real, 'utf8')).toContain('edited')
  })

  it('the root itself may be a symlink (compared by real path)', async () => {
    const real = join(dir, 'real-root'); mkdirSync(join(real, 'a'), { recursive: true })
    writeFileSync(join(real, 'a', 'SKILL.md'), skill('a'))
    symlinkSync(real, join(dir, 'linked-root'))
    const [e] = await scanRoot({ path: join(dir, 'linked-root'), source: 'user-agents', rank: 500 })
    expect(e!.outsideRoot).toBe(false)
    expect(e!.writable).toBe(true)
  })

  it('swap between scan and save: a regular file replaced by a symlink is refused', async () => {
    const root = join(dir, 'root'); mkdirSync(join(root, 'x'), { recursive: true })
    const file = join(root, 'x', 'SKILL.md'); writeFileSync(file, skill('x'))
    const [e] = await scanRoot({ path: root, source: 'project-agents', rank: 200 })
    expect(e!.writable).toBe(true)
    const victim = join(dir, 'victim.txt'); writeFileSync(victim, 'PRECIOUS\n')
    rmSync(file); symlinkSync(victim, file) // the attacker's swap, after the scan
    await expect(saveSkill(opts(), e!, skill('x', 'pwn'), sha256(skill('x')))).rejects.toMatchObject({ code: expect.stringMatching(/conflict|outside-root|not-found/) })
    expect(readFileSync(victim, 'utf8')).toBe('PRECIOUS\n')
  })

  it('swap of the skill directory for a symlink after the scan is refused', async () => {
    const root = join(dir, 'root'); mkdirSync(join(root, 'x'), { recursive: true })
    writeFileSync(join(root, 'x', 'SKILL.md'), skill('x'))
    const [e] = await scanRoot({ path: root, source: 'project-agents', rank: 200 })
    const outside = join(dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'SKILL.md'), skill('x', 'OUTSIDE'))
    renameSync(join(root, 'x'), join(dir, 'moved')); symlinkSync(outside, join(root, 'x'))
    await expect(saveSkill(opts(), e!, skill('x', 'pwn'), sha256(skill('x', 'OUTSIDE')))).rejects.toMatchObject({ code: expect.stringMatching(/conflict|outside-root/) })
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toContain('OUTSIDE')
  })

  it('verifyContained is what saveSkill calls: a late swap is caught by the second check', async () => {
    const root = join(dir, 'root'); mkdirSync(join(root, 'y'), { recursive: true })
    const file = join(root, 'y', 'SKILL.md'); writeFileSync(file, skill('y'))
    const [e] = await scanRoot({ path: root, source: 'project-dsh', rank: 100 })
    await expect(verifyContained(e!)).resolves.toBe(e!.realPath)
    const victim = join(dir, 'v.txt'); writeFileSync(victim, 'V')
    rmSync(file); symlinkSync(victim, file)
    await expect(verifyContained(e!)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('duplicate refuses to copy an out-of-root file from a project root; the page gets no text for it', async () => {
    const root = join(dir, 'proj', '.agents', 'skills'); mkdirSync(join(root, 'evil'), { recursive: true })
    const secret = join(dir, 'secret.md'); writeFileSync(secret, '---\nname: evil\ndescription: secret stuff here.\n---\nTOP SECRET\n')
    symlinkSync(secret, join(root, 'evil', 'SKILL.md'))
    const [e] = await scanRoot({ path: root, source: 'project-agents', rank: 200 })
    const target = join(dir, 'user-skills'); mkdirSync(target)
    await expect(duplicateSkill(e!, 'copy', target, [target])).rejects.toMatchObject({ code: 'outside-root' })
    expect(existsSync(join(target, 'copy'))).toBe(false)
  })

  it('user roots keep their historic symlinks readable (but still read-only) so the page can show them', async () => {
    const root = join(dir, 'home', '.agents', 'skills'); mkdirSync(root, { recursive: true })
    mkdirSync(join(dir, 'sys', 'sk'), { recursive: true }); writeFileSync(join(dir, 'sys', 'sk', 'SKILL.md'), skill('sk'))
    symlinkSync(join(dir, 'sys', 'sk'), join(root, 'sk'))
    const [e] = await scanRoot({ path: root, source: 'user-agents', rank: 500 })
    expect(e!.contentReadable).toBe(true)
    expect(e!.writable).toBe(false)
    const rows = buildRows({ scan: await scanRoots(await computeRoots({ dshHome: join(dir, 'dsh'), agentsHome: join(dir, 'home') })), winners: undefined, settings: emptySettings(), projectRoot: undefined, usage: {} })
    expect(rows.find((r) => r.name === 'sk')).toMatchObject({ editable: false, readOnlyReason: 'outside-root' })
  })
})

// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'
import { SettingsStore, applyToggle, emptySettings, isHidden, normalizeSettings, stateOf } from '../src/host/store.ts'
import { computeRoots, scanRoots, sha256 } from '../src/host/scanner.ts'
import { buildRows } from '../src/host/model.ts'
import { createSkill, saveSkill, WriteRefusal } from '../src/host/writer.ts'

const base = join(import.meta.dirname, '..', '.tmp', 'tests')
mkdirSync(base, { recursive: true })
let dir: string
beforeEach(() => { dir = mkdtempSync(join(base, 't-')) })

const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: Test skill ${name}.\n${extra}---\n\n# ${name}\nbody\n`
function put(root: string, folder: string, text: string): string {
  mkdirSync(join(root, folder), { recursive: true })
  const f = join(root, folder, 'SKILL.md')
  writeFileSync(f, text)
  return f
}

describe('settings store', () => {
  it('persists atomically and survives a reload; toggling never touches other files', async () => {
    const s = new SettingsStore(join(dir, 'state'))
    await s.load()
    await s.update(d => { applyToggle(d, 'a', true, 'global') })
    expect(stateOf(s.settings, 'a', undefined)).toBe('disabled-global')
    const again = new SettingsStore(join(dir, 'state'))
    await again.load()
    expect(again.settings.disabled).toEqual(['a'])
    expect(readdirSync(join(dir, 'state'))).toEqual(['settings.json'])
    expect(statSync(join(dir, 'state', 'settings.json')).mode & 0o777).toBe(0o600)
  })
  it('workspace overrides: hide here, re-enable here despite a global disable', () => {
    const s = emptySettings()
    applyToggle(s, 'x', true, { workspace: '/w' })
    expect(stateOf(s, 'x', '/w')).toBe('disabled-workspace')
    expect(stateOf(s, 'x', '/other')).toBe('enabled')
    applyToggle(s, 'y', true, 'global')
    applyToggle(s, 'y', false, { workspace: '/w' })
    expect(stateOf(s, 'y', '/w')).toBe('enabled-workspace')
    expect(isHidden(stateOf(s, 'y', '/w'))).toBe(false)
    expect(stateOf(s, 'y', '/other')).toBe('disabled-global')
    applyToggle(s, 'y', true, { workspace: '/w' })
    expect(stateOf(s, 'y', '/w')).toBe('disabled-global')
  })
  it('normalizes garbage input', () => {
    expect(normalizeSettings('x')).toEqual(emptySettings())
    expect(normalizeSettings({ disabled: ['a', 1, 'a'], workspaces: { '/w': { disable: ['q'], enable: [] }, '/e': {} } })).toEqual({ version: 1, disabled: ['a'], workspaces: { '/w': { disable: ['q'], enable: [] } } })
  })
})

describe('scanner + rows', () => {
  it('finds shadowed duplicates, invalid files and symlinks that the registry would drop', async () => {
    const proj = join(dir, 'proj'); mkdirSync(join(proj, '.git'), { recursive: true })
    const home = join(dir, 'home'); const dshHome = join(dir, 'dshhome')
    put(join(proj, '.agents/skills'), 'dup', skill('dup'))
    put(join(home, '.agents/skills'), 'dup', skill('dup'))
    put(join(home, '.agents/skills'), 'solo', skill('solo'))
    put(join(home, '.agents/skills'), 'broken', '# no frontmatter')
    put(join(home, '.agents/skills'), 'legacy', skill('legacy', 'userInvocable: false\n'))
    mkdirSync(join(dir, 'elsewhere/linked'), { recursive: true })
    writeFileSync(join(dir, 'elsewhere/linked/SKILL.md'), skill('linked'))
    symlinkSync(join(dir, 'elsewhere/linked'), join(home, '.agents/skills/linked'))
    const roots = await computeRoots({ cwd: proj, dshHome, agentsHome: home })
    const scan = await scanRoots(roots)
    const rows = buildRows({ scan, winners: undefined, settings: emptySettings(), projectRoot: proj, usage: {} })
    const dups = rows.filter(r => r.name === 'dup')
    expect(dups.map(r => [r.source, r.state])).toEqual([['project-agents', 'active'], ['user-agents', 'shadowed']])
    expect(dups[0]!.shadows).toBe(1)
    expect(dups[1]!.shadowedBy?.source).toBe('project-agents')
    expect(rows.find(r => r.name === 'broken')!.state).toBe('invalid')
    expect(rows.find(r => r.name === 'legacy')!.state).toBe('invalid')
    expect(rows.find(r => r.name === 'linked')!.symlink).toBe(true)
    expect(rows.find(r => r.name === 'solo')!.state).toBe('active')
  })
  it('registry winners with no file under a root become disable-only plugin rows; a registry winner decides shadowing', async () => {
    const home = join(dir, 'home')
    const f = put(join(home, '.agents/skills'), 'a', skill('a'))
    const roots = await computeRoots({ dshHome: join(dir, 'd'), agentsHome: home })
    const scan = await scanRoots(roots)
    const winners = [{ name: 'a', path: scan[0]!.realPath, source: 'user-agents' }, { name: 'bundled-thing', description: 'from a plugin', source: 'runtime', provider: 'runtime' }]
    const rows = buildRows({ scan, winners, settings: normalizeSettings({ disabled: ['bundled-thing'] }), projectRoot: undefined, usage: { a: { count: 3, lastUsed: 1, sessions: 2 } } })
    const plugin = rows.find(r => r.name === 'bundled-thing')!
    expect(plugin.editable).toBe(false)
    expect(plugin.readOnlyReason).toBe('plugin')
    expect(plugin.disabled).toBe('disabled-global')
    expect(rows.find(r => r.name === 'a')!.usage?.count).toBe(3)
    expect(f).toBeTruthy()
  })
})

describe('writer', () => {
  const opts = () => ({ backupsDir: join(dir, 'backups') })

  async function entryFor(root: string) {
    const scan = await scanRoots([{ path: root, source: 'user-agents', rank: 500 }])
    return scan[0]!
  }

  it('save: backs up the previous content, writes atomically, enforces the sha lock', async () => {
    const root = join(dir, 'skills'); const file = put(root, 'ed', skill('ed'))
    const e = await entryFor(root)
    const before = readFileSync(file, 'utf8')
    const next = before.replace('body', 'changed body')
    const res = await saveSkill(opts(), e, next, sha256(before))
    expect(readFileSync(file, 'utf8')).toBe(next)
    expect(readFileSync(res.backup, 'utf8')).toBe(before)
    expect(res.backup.startsWith(join(dir, 'backups', 'ed'))).toBe(true)
    // stale base hash is a conflict and changes nothing
    await expect(saveSkill(opts(), e, 'x', sha256(before))).rejects.toMatchObject({ code: 'conflict' })
    expect(readFileSync(file, 'utf8')).toBe(next)
    expect(readdirSync(join(root, 'ed')).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
  it('save: refuses content that DSH would drop and leaves the file and backups untouched', async () => {
    const root = join(dir, 'skills'); const file = put(root, 'ed', skill('ed'))
    const e = await entryFor(root); const before = readFileSync(file, 'utf8')
    const err = await saveSkill(opts(), e, '# no frontmatter', sha256(before)).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(WriteRefusal)
    expect((err as WriteRefusal).code).toBe('invalid')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })
  it('save: refuses read-only targets', async () => {
    const root = join(dir, 'skills'); const file = put(root, 'ro', skill('ro'))
    chmodSync(file, 0o444)
    const e = await entryFor(root)
    expect(e.writable).toBe(false)
    await expect(saveSkill(opts(), e, skill('ro'), sha256(readFileSync(file)))).rejects.toMatchObject({ code: 'read-only' })
    chmodSync(file, 0o644)
  })
  it('save refuses a symlinked folder whose real file lies outside the root (SS-1, was: followed it)', async () => {
    const root = join(dir, 'skills'); mkdirSync(root)
    const real = put(join(dir, 'elsewhere'), 'lk', skill('lk'))
    symlinkSync(join(dir, 'elsewhere/lk'), join(root, 'lk'))
    const e = await entryFor(root)
    expect(e.outsideRoot).toBe(true)
    expect(e.writable).toBe(false)
    const before = readFileSync(real, 'utf8')
    await expect(saveSkill(opts(), e, before.replace('body', 'via link'), sha256(before))).rejects.toMatchObject({ code: 'read-only' })
    expect(readFileSync(real, 'utf8')).toBe(before)
  })
  it('create: writes <root>/<name>/SKILL.md, validates, refuses duplicates, bad names and foreign roots', async () => {
    const root = join(dir, 'agents-skills')
    const res = await createSkill({ name: 'brand-new', description: 'Use for brand new things.', root }, [root])
    expect(res.path).toBe(join(root, 'brand-new', 'SKILL.md'))
    expect(readFileSync(res.path, 'utf8')).toMatch(/^---\nname: brand-new\n/)
    expect(statSync(res.path).mode & 0o777).toBe(0o644)
    await expect(createSkill({ name: 'brand-new', description: 'x', root }, [root])).rejects.toMatchObject({ code: 'exists' })
    await expect(createSkill({ name: '../evil', description: 'x', root }, [root])).rejects.toMatchObject({ code: 'bad-name' })
    await expect(createSkill({ name: 'Bad Name', description: 'x', root }, [root])).rejects.toMatchObject({ code: 'bad-name' })
    await expect(createSkill({ name: 'ok-name', description: 'x', root: join(dir, 'other') }, [root])).rejects.toMatchObject({ code: 'bad-target' })
    await expect(createSkill({ name: 'no-desc', description: '  ', root }, [root])).rejects.toMatchObject({ code: 'invalid' })
    expect(existsSync(join(root, 'no-desc'))).toBe(false)
  })
})

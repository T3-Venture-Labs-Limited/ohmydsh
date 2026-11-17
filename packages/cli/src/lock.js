// ohmydsh.lock.json: what omd installed into a profile, so update/rollback can tell ours from the user's.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE = 'ohmydsh.lock.json'

export function readLock(profileDir) {
  const file = join(profileDir, LOCK_FILE)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function writeLock(profileDir, lock) {
  writeFileSync(join(profileDir, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`)
}

export function makeLock({ manifest, source, dev, packs, plugins, official, now = new Date() }) {
  return {
    lockVersion: 1,
    manifest: { version: manifest.version, dsh: manifest.dsh, source },
    dev: Boolean(dev),
    updatedAt: now.toISOString(),
    packs: [...packs].sort(),
    official: [...official],
    plugins: Object.fromEntries([...plugins].map(([name, p]) => [name, { version: p.version, spec: p.spec, origin: [...p.origin] }])),
  }
}

const same = (a, b) => a.version === b.version && a.spec === b.spec

/**
 * Compare what the lock says we installed with what the manifest wants.
 * @param {ReturnType<typeof readLock>} lock  null for a profile omd never touched
 * @param {Map<string, {version: string, spec: string}>} desired
 */
export function diffLock(lock, desired) {
  const have = lock?.plugins ?? {}
  const add = []
  const change = []
  const keep = []
  for (const [name, to] of desired) {
    const from = have[name]
    if (!from) add.push({ name, to })
    else if (!same(from, to)) change.push({ name, from, to })
    else keep.push(name)
  }
  const remove = Object.keys(have).filter((name) => !desired.has(name)).map((name) => ({ name, from: have[name] }))
  return { add, change, remove, keep, empty: add.length + change.length + remove.length === 0 }
}

/** Split a profile's package.json dependencies into plugins omd installed and ones the user added. */
export function classifyDeps(pkg, lock) {
  const names = Object.keys(pkg?.dependencies ?? {})
  const ours = names.filter((n) => lock?.plugins?.[n])
  const user = names.filter((n) => !lock?.plugins?.[n])
  return { ours, user }
}

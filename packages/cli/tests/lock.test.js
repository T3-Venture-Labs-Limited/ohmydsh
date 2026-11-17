import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyDeps, diffLock, makeLock, readLock, writeLock } from '../src/lock.js'
import { parseManifest, resolveDesired } from '../src/manifest.js'
import { baseManifest, fakeProfile, tmp } from './helpers.js'

const desired = (packs = []) => resolveDesired(parseManifest(JSON.stringify(baseManifest())), { packs, source: '/x/ohmydsh.json' }).plugins

test('diff against no lock: everything is an add', () => {
  const d = diffLock(null, desired())
  assert.deepEqual(d.add.map((a) => a.name), ['dsh-a', '@ohmydsh/b'])
  assert.equal(d.change.length + d.remove.length, 0)
})

test('diff: unchanged, changed version, removed plugin', () => {
  const lock = makeLock({ manifest: parseManifest(JSON.stringify(baseManifest())), source: '/x', dev: false, packs: ['extra'], plugins: desired(['extra']), official: [] })
  assert.equal(diffLock(lock, desired(['extra'])).empty, true)
  const bumped = desired(['extra'])
  bumped.get('dsh-a').version = '1.1.0'
  bumped.get('dsh-a').spec = '1.1.0'
  const d = diffLock(lock, bumped)
  assert.deepEqual(d.change.map((c) => [c.name, c.from.version, c.to.version]), [['dsh-a', '1.0.0', '1.1.0']])
  const d2 = diffLock(lock, desired([]))
  assert.deepEqual(d2.remove.map((r) => r.name), ['dsh-c'])
})

test('a link: to tarball switch counts as a change even at the same version', () => {
  const lock = makeLock({ manifest: parseManifest(JSON.stringify(baseManifest())), source: '/x', dev: true, packs: [], plugins: desired(), official: [] })
  lock.plugins['@ohmydsh/b'].spec = 'link:/some/dir'
  assert.deepEqual(diffLock(lock, desired()).change.map((c) => c.name), ['@ohmydsh/b'])
})

test('ours vs user-added: classifyDeps keeps the user plugins out of the lock set', () => {
  const lock = makeLock({ manifest: parseManifest(JSON.stringify(baseManifest())), source: '/x', dev: false, packs: [], plugins: desired(), official: [] })
  const pkg = { dependencies: { 'dsh-a': '1.0.0', '@ohmydsh/b': 'x', 'my-own-plugin': 'link:/home/me/p' } }
  assert.deepEqual(classifyDeps(pkg, lock), { ours: ['dsh-a', '@ohmydsh/b'], user: ['my-own-plugin'] })
  assert.deepEqual(classifyDeps(pkg, null).ours, [])
})

test('lock round trip on disk; missing lock reads as null', () => {
  const home = tmp()
  const dir = fakeProfile(home, 'omd')
  assert.equal(readLock(dir), null)
  const lock = makeLock({ manifest: parseManifest(JSON.stringify(baseManifest())), source: '/x', dev: false, packs: ['extra', 'extra'], plugins: desired(['extra']), official: ['o'], now: new Date('2026-01-01T00:00:00Z') })
  writeLock(dir, lock)
  assert.deepEqual(readLock(dir), lock)
  assert.equal(lock.updatedAt, '2026-01-01T00:00:00.000Z')
})

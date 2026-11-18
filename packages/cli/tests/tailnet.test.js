import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readLock } from '../src/lock.js'
import { parseManifest } from '../src/manifest.js'
import { profileDir, syncProfile } from '../src/profile.js'
import { mergeHosts, normalizeHost, tailnetHosts, trustedHostsRow } from '../src/tailnet.js'
import { baseManifest, silentLog, tmp } from './helpers.js'

const tsStatus = (dns) => ({ status: 0, stdout: JSON.stringify({ Self: { DNSName: dns } }), stderr: '' })

test('tailnetHosts reads the MagicDNS name and short name; [] when Tailscale is missing or down', () => {
  assert.deepEqual(tailnetHosts({ run: () => tsStatus('Laptop.tail1234.ts.net.') }), ['laptop.tail1234.ts.net', 'laptop'])
  assert.deepEqual(tailnetHosts({ run: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }) }), [])
  assert.deepEqual(tailnetHosts({ run: () => ({ status: 1, stdout: '', stderr: 'not running' }) }), [])
  assert.deepEqual(tailnetHosts({ run: () => ({ status: 0, stdout: 'garbage', stderr: '' }) }), [])
  assert.deepEqual(tailnetHosts({ run: () => tsStatus('') }), [])
})

test('hosts are validated and deduplicated; nothing that could break out of the YAML/JS row gets through', () => {
  assert.equal(normalizeHost('a.b:8443'), 'a.b:8443')
  for (const bad of ["x'y", 'a b', 'a/b', '"', '', '-a', 'a]']) assert.equal(normalizeHost(bad), null, bad)
  assert.deepEqual(mergeHosts(['A.example'], ['a.example', 'bad host'], undefined, ['b']), ['a.example', 'b'])
})

test('trustedHostsRow keeps launch-time --trusted-host values and is empty without hosts', () => {
  assert.equal(trustedHostsRow([]), '')
  const row = trustedHostsRow(['m.tail1.ts.net', 'm'])
  assert.match(row, /- id: connection\n  name: '@deepseek-ai\/dsh-client-connection'/)
  assert.match(row, /trustedHosts: !!js '\["m\.tail1\.ts\.net", "m", \.\.\.ctx\.webStartup\.trustedHosts\]'/)
})

function runner(home, { tailscale }) {
  return (cmd, args) => {
    if (cmd === 'tailscale') return tailscale()
    const profile = args[args.indexOf('--profile') + 1]
    if (args.includes('--dump-config')) {
      const dir = join(home, 'profiles', profile)
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      return { status: 0, stdout: [...Object.keys(pkg.dependencies).map((n) => `# == ${n}\n- id: ${n}\n`), '# == user\n', ...[...patch.matchAll(/id: (\S+)/g)].map((m) => `- id: ${m[1]}\n`)].join(''), stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
}

test('sync saves the Tailscale name in the profile and keeps it when a later run cannot see Tailscale', async () => {
  const home = tmp()
  const loaded = { manifest: parseManifest(JSON.stringify(baseManifest())), source: '/x/ohmydsh.json', readRelative: async () => '' }
  const ctx = (tailscale) => ({ home, env: {}, log: silentLog(), isRunning: () => false, run: runner(home, { tailscale }) })
  const live = profileDir(home, 'omd')

  await syncProfile(ctx(() => tsStatus('box.tail9.ts.net.')), { loaded, name: 'omd', packs: [], dev: false, trustedHosts: ['extra.example'] })
  assert.deepEqual(readLock(live).trustedHosts, ['box.tail9.ts.net', 'box', 'extra.example'])
  assert.match(readFileSync(join(live, 'cordis.patch.yml'), 'utf8'), /# >>> ohmydsh[\s\S]*"box\.tail9\.ts\.net", "box", "extra\.example", \.\.\.ctx\.webStartup\.trustedHosts[\s\S]*# <<< ohmydsh/)

  // Tailscale down during an update (e.g. right after boot): the saved hosts must survive.
  await syncProfile(ctx(() => ({ status: 1, stdout: '', stderr: 'stopped' })), { loaded, name: 'omd', packs: [], dev: false })
  assert.deepEqual(readLock(live).trustedHosts, ['box.tail9.ts.net', 'box', 'extra.example'])
  assert.match(readFileSync(join(live, 'cordis.patch.yml'), 'utf8'), /"box\.tail9\.ts\.net"/)
})

test('no Tailscale and no flag: no connection row, so DSH defaults are untouched', async () => {
  const home = tmp()
  const loaded = { manifest: parseManifest(JSON.stringify(baseManifest())), source: '/x/ohmydsh.json', readRelative: async () => '' }
  await syncProfile({ home, env: {}, log: silentLog(), isRunning: () => false, run: runner(home, { tailscale: () => ({ status: 1, stdout: '', stderr: '' }) }) }, { loaded, name: 'omd', packs: [], dev: false })
  assert.doesNotMatch(readFileSync(join(profileDir(home, 'omd'), 'cordis.patch.yml'), 'utf8'), /id: connection/)
  assert.deepEqual(readLock(profileDir(home, 'omd')).trustedHosts, [])
})

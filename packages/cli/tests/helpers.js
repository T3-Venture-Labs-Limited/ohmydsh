import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tmp(prefix = 'omd-test-') {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix))
}

export const baseManifest = () => ({
  version: '0.1.0',
  dsh: '0.2.2-rc.3',
  plugins: {
    core: { 'dsh-a': '1.0.0', '@ohmydsh/b': '0.1.0' },
    packs: { extra: { 'dsh-c': '2.0.0' } },
  },
  sources: { '@ohmydsh/b': { workspace: 'packages/b', tarball: 'https://example.invalid/b-0.1.0.tgz' } },
})

export function silentLog() {
  const lines = []
  const push = (k) => (s) => lines.push(`${k}: ${s}`)
  return { lines, step: push('step'), info: push('info'), ok: push('ok'), warn: push('warn'), error: push('error'), raw: push('raw') }
}

/** Write a fake profile dir and return its path. */
export function fakeProfile(home, name, files = {}) {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  return dir
}

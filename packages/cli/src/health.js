// Health checks: compose the profile with `dsh --dump-config` and look for rows that did not apply.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rowIds } from './managed.js'

/** dsh only warns when a patch row names a plugin that is not there. Those warnings are failures for us. */
export function parseUnapplied(stderr) {
  const out = []
  for (const m of stderr.matchAll(/patch: entry "([^"]+)" not found/g)) out.push(m[1])
  return out
}

/** Other stderr lines that mean the composed config is not what we meant. */
export function parseProblems(stderr) {
  return stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '' && /not found|unknown|invalid|error|failed|cannot/i.test(l) && !/patch: entry "[^"]+" not found/.test(l))
}

/** The `# == <bundle>[, patched by <layer>]` headers of a --dump-config output: which bundles contributed rows. */
export function dumpedBundles(stdout) {
  return new Set([...stdout.matchAll(/^# == (.+)$/gm)].map((m) => m[1].split(', patched by ')[0].trim()))
}

export function dumpedRowIds(stdout) {
  return new Set([...stdout.matchAll(/^- id: (.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, '')))
}

/**
 * Compose a profile and check it.
 * @param {{ run: Function, env: NodeJS.ProcessEnv }} ctx
 * @param {{ profile: string, plugins: string[], managedYaml?: string }} want
 */
export function composeCheck(ctx, want) {
  const r = ctx.run('dsh', ['--profile', want.profile, '--dump-config'], { env: ctx.env })
  const result = { ok: true, errors: [], unapplied: [], missingBundles: [], missingRows: [] }
  if (r.error || r.status !== 0) {
    result.ok = false
    result.errors.push(r.error ? `could not run dsh: ${r.error.message}` : `dsh --dump-config exited ${String(r.status)}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`)
    return result
  }
  result.unapplied = parseUnapplied(r.stderr)
  const problems = parseProblems(r.stderr)
  if (problems.length > 0) result.errors.push(...problems)
  const bundles = dumpedBundles(r.stdout)
  result.missingBundles = want.plugins.filter((name) => !bundles.has(name))
  if (want.managedYaml) {
    const ids = dumpedRowIds(r.stdout)
    result.missingRows = rowIds(want.managedYaml).filter((id) => !ids.has(id))
  }
  if (result.unapplied.length > 0 || result.errors.length > 0 || result.missingBundles.length > 0 || result.missingRows.length > 0) result.ok = false
  return result
}

export function describeCompose(res) {
  const out = []
  for (const e of res.errors) out.push(e)
  if (res.unapplied.length > 0) out.push(`unapplied patch rows (they name plugins that are not active): ${res.unapplied.join(', ')}`)
  if (res.missingBundles.length > 0) out.push(`plugins that did not contribute to the config: ${res.missingBundles.join(', ')}`)
  if (res.missingRows.length > 0) out.push(`managed rows missing from the composed config: ${res.missingRows.join(', ')}`)
  return out
}

/** Version of the installed dsh CLI (`dsh --version`), or null. */
export function dshVersion(ctx) {
  const r = ctx.run('dsh', ['--version'], { env: ctx.env })
  if (r.error || r.status !== 0) return null
  return r.stdout.trim().split('\n').pop().trim()
}

/** Installed version of a plugin in a profile, or null. */
export function installedVersion(profileDir, name) {
  const file = join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')).version ?? null } catch { return null }
}

/**
 * Is a DSH process running on this profile directory? Linux only (reads DSH_PROFILE_DIR from /proc/<pid>/environ of
 * our own processes). Returns null when we cannot tell.
 */
export function isProfileRunning(profileDir, procRoot = '/proc') {
  if (!existsSync(procRoot)) return null
  let entries
  try { entries = readdirSync(procRoot) } catch { return null }
  const needle = `DSH_PROFILE_DIR=${profileDir}\0`
  let looked = 0
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue
    try {
      if (readFileSync(join(procRoot, e, 'environ'), 'latin1').includes(needle)) return true
      looked++
    } catch { /* not ours, or gone */ }
  }
  return looked > 0 ? false : null
}

/**
 * Boot the web app of a profile briefly and watch its output for load failures. Opt-in: it starts the plugins, so it
 * runs against whatever DSH_HOME is set. Resolves { ok, url, problems }.
 */
export function bootCheck(ctx, profile, { port = 0, graceMs = 4000, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('dsh', [profile, '--no-open', '--port', String(port)], { env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    let url = null
    let done = false
    const BAD = /failed to import|startup failed|fatal load failure|did not activate|client-modules: client bundle not found/i
    const finish = (extra) => {
      if (done) return
      done = true
      clearTimeout(hard)
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref()
      const problems = text.split('\n').filter((l) => BAD.test(l)).slice(0, 5)
      if (extra) problems.push(extra)
      resolve({ ok: url !== null && problems.length === 0, url, problems, log: text })
    }
    const onData = (d) => {
      text += d.toString()
      const m = /(https?:\/\/127\.0\.0\.1:\d+)\S*/.exec(text)
      if (m && url === null) { url = m[1]; setTimeout(() => finish(), graceMs) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => finish(`could not start dsh: ${e.message}`))
    child.on('exit', (code) => finish(url === null ? `dsh exited ${String(code)} before serving` : undefined))
    const hard = setTimeout(() => finish('timed out waiting for the web server'), timeoutMs)
  })
}

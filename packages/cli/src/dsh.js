// Moving DeepSeek Harness itself together with the profile, so a failed update always leaves a working pair.
//
//   plan    do we need to change the installed DSH, and may we (not with --no-dsh-install, not for a DSH we did not install)
//   stage   install the wanted DSH into a throwaway npm prefix; the profile is built and checked with THAT binary
//   switch  only after the profile passed its check and was swapped in: install the wanted DSH where the old one lives
//
// Nothing here restarts a running DSH. The profile swap that comes first already refuses to run under a live DSH.
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { dshVersion } from './health.js'
import { OmdError, which } from './util.js'

const slash = (p) => p.replace(/\\/g, '/')
const lastLines = (r, n = 8) => (r.error?.message ?? `${r.stdout}\n${r.stderr}`).trim().split('\n').slice(-n).join('\n')
export const dshSpec = (version) => `@deepseek-ai/dsh@${version}`

/**
 * How is the `dsh` on PATH installed?
 *   npm        <prefix>/lib/node_modules/@deepseek-ai/dsh (npm install -g): we can replace it in place
 *   mise       a mise npm tool or shim: we use `mise use -g`
 *   unmanaged  anything else (the desktop app's own runtime, pnpm/bun/volta globals, a checkout): never touched
 *   none       no dsh on PATH
 */
export function detectDshInstall(ctx) {
  const bin = which('dsh', ctx.env)
  if (!bin) return { kind: 'none', bin: null }
  let real = bin
  try { real = realpathSync(bin) } catch { /* keep the PATH entry */ }
  if (/\/mise\/installs\/npm-[^/]*dsh[^/]*\//.test(slash(real)) || /\/mise\/shims\//.test(slash(bin))) return { kind: 'mise', bin: real }
  const m = /^(.*)\/lib\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/.exec(slash(real))
  if (m) return { kind: 'npm', bin: real, prefix: m[1] }
  return { kind: 'unmanaged', bin: real }
}

/** @returns {{ action: 'none' | 'skip' | 'install', have: string | null, want: string, install?: ReturnType<typeof detectDshInstall>, reason?: string }} */
export function planDsh(ctx, manifestDsh) {
  const have = dshVersion(ctx)
  if (have === manifestDsh) return { action: 'none', have, want: manifestDsh }
  if (ctx.flags['no-dsh-install'] || ctx.env.OMD_NO_DSH_INSTALL) return { action: 'skip', have, want: manifestDsh, reason: '--no-dsh-install' }
  const install = detectDshInstall(ctx)
  if (install.kind === 'unmanaged') return { action: 'skip', have, want: manifestDsh, reason: `${install.bin} was not installed by npm or mise, so omd does not replace it` }
  return { action: 'install', have, want: manifestDsh, install }
}

export function warnSkipped(ctx, plan) {
  ctx.log.warn(`DSH ${plan.have ?? '(not found)'} is installed, this set was tested with ${plan.want}. Not changing it (${plan.reason}); install ${dshSpec(plan.want)} yourself.`)
}

/** Install `version` into a private prefix and return an env whose PATH starts with it. Call cleanup() when done. */
export function stageDsh(ctx, version) {
  const dir = join(ctx.home, '.omd-dsh-stage')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  const r = ctx.run('npm', ['install', '-g', '--prefix', dir, '--no-audit', '--no-fund', dshSpec(version)], { env: ctx.env })
  if (r.error || r.status !== 0) { cleanup(); throw new OmdError(`could not install ${dshSpec(version)} to try it first (nothing was changed):\n${lastLines(r)}`) }
  const env = { ...ctx.env, PATH: `${join(dir, 'bin')}${delimiter}${dir}${delimiter}${ctx.env.PATH ?? ''}` }
  const got = dshVersion({ ...ctx, env })
  if (got !== version) { cleanup(); throw new OmdError(`installed ${dshSpec(version)} to try it, but its \`dsh --version\` reports ${got ?? 'nothing'} (nothing was changed)`) }
  return { dir, env, cleanup }
}

// OMD_DSH_INSTALLER=npm forces npm for a first install (CI and the release gate, where mise must not be consulted).
function installInPlace(ctx, install, version) {
  const spec = dshSpec(version)
  if (install.kind === 'mise' || (install.kind === 'none' && ctx.env.OMD_DSH_INSTALLER !== 'npm' && which('mise', ctx.env))) return ctx.run('mise', ['use', '-g', `npm:${spec}`], { env: ctx.env })
  const args = ['install', '-g', '--no-audit', '--no-fund', ...(install.kind === 'npm' ? ['--prefix', install.prefix] : []), spec]
  return ctx.run('npm', args, { env: ctx.env })
}

/**
 * Put `version` where the current DSH lives. If that fails the previous version is reinstalled (best effort) and an
 * OmdError says what state the machine is in.
 */
export function switchDsh(ctx, install, version, previous) {
  ctx.log.step(`switching DeepSeek Harness to ${version}`)
  const r = installInPlace(ctx, install, version)
  const got = r.error || r.status !== 0 ? null : (install.kind === 'mise' ? miseVersion(ctx) ?? dshVersion(ctx) : dshVersion(ctx))
  if (got === version) return
  let restored = previous === null
  if (previous) { const back = installInPlace(ctx, install, previous); restored = !back.error && back.status === 0 }
  throw new OmdError(`could not switch DSH to ${version}${got ? ` (\`dsh --version\` reports ${got})` : `:\n${lastLines(r)}`}\n  ${previous ? (restored ? `DSH ${previous} was put back.` : `Putting DSH ${previous} back failed too: run \`npm install -g ${dshSpec(previous)}\`.`) : ''}`.trimEnd())
}

/** `mise exec -- dsh --version`: a fresh lookup, because the PATH of a running shell still points at the old version. */
function miseVersion(ctx) {
  const r = ctx.run('mise', ['exec', '--', 'dsh', '--version'], { env: ctx.env })
  return r.error || r.status !== 0 ? null : r.stdout.trim().split('\n').pop().trim()
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../src/args.js'
import * as cmd from '../src/commands.js'
import { bootCheck } from '../src/health.js'
import { OmdError, dshHome, makeLog, run } from '../src/util.js'

const HELP = `omd: ohmydsh for DeepSeek Harness

Usage: omd [command] [options]

  omd                  start the web UI (same as: dsh omd)
  omd setup            first-time install, or repair an existing install
  omd add <pack>...    add optional packs
  omd remove <pack>... remove optional packs
  omd update           update to the newest tested set
  omd rollback         return to the previous set (run it again to undo)
  omd doctor           health check: versions, plugins, logins, keys
  omd list             show installed plugins and versions

Options:
  --manifest <path|url>  use this ohmydsh.json (default: the checkout this runs from, else the published one)
  --dev                  link plugins from the workspace folders instead of release tarballs (needs a checkout)
  --pack <a,b>           setup: also enable these packs
  --dry-run              update: show what would change
  --boot-check           also boot the staged web app briefly and look for load failures
  --force                swap the profile even if a DSH is running on it
  --no-dsh-install       setup: do not install the pinned DSH
  --trusted-host <a,b>   setup/update: also accept browsers on these hosts (this machine's Tailscale name is added
                         automatically; saved in the profile so it works right after a reboot)
  --profile <name>       profile to manage (default: omd)

omd never restarts a running DSH, never edits rows outside its own block, and never copies logins.
`

const COMMANDS = new Set(['setup', 'add', 'remove', 'update', 'rollback', 'doctor', 'list', 'help'])
const argv = process.argv.slice(2)
const first = argv[0]

if (first === '--version' || first === '-V') {
  const { readFileSync } = await import('node:fs')
  process.stdout.write(`${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`)
  process.exit(0)
}
if (first === '--help' || first === '-h' || first === 'help') { process.stdout.write(HELP); process.exit(0) }

if (first === undefined || !COMMANDS.has(first)) {
  // Default: hand over to DSH on the omd profile, passing everything through.
  const profile = process.env.OMD_PROFILE ?? 'omd'
  const r = spawnSync('dsh', [profile, ...argv], { stdio: 'inherit' })
  if (r.error) { process.stderr.write(`omd: could not run dsh: ${r.error.message}\n`); process.exit(127) }
  process.exit(r.status ?? 1)
}

const { flags, positional } = parseArgs(argv.slice(1))
if (flags.help) { process.stdout.write(HELP); process.exit(0) }
const env = process.env
const ctx = {
  flags,
  env,
  home: dshHome(env),
  run,
  fetch: globalThis.fetch,
  log: makeLog(),
  cliDir: dirname(fileURLToPath(import.meta.url)),
  exitCode: 0,
}
ctx.bootCheck = (profile) => bootCheck(ctx, profile)

try {
  if (first === 'setup') await cmd.setup(ctx)
  else if (first === 'add') await cmd.add(ctx, positional)
  else if (first === 'remove') await cmd.remove(ctx, positional)
  else if (first === 'update') await cmd.update(ctx)
  else if (first === 'rollback') await cmd.rollback(ctx)
  else if (first === 'doctor') await cmd.doctor(ctx)
  else if (first === 'list') await cmd.list(ctx)
} catch (e) {
  if (e instanceof OmdError) { ctx.log.error(e.message); process.exit(1) }
  throw e
}
process.exit(ctx.exitCode)

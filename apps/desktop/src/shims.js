'use strict'
// DSH, omd and pnpm expect `node`, `dsh` and `pnpm` on PATH. The app ships none of them: Electron is the Node
// (ELECTRON_RUN_AS_NODE=1), so we write tiny launcher scripts that call it, and put their folder on PATH for every child.
const fs = require('node:fs')
const path = require('node:path')

function unixShim(electron, target) {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electron}" ${target}\n`
}
function winShim(electron, target) {
  return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electron}" ${target}\r\n`
}

/**
 * @param {{ bin: string, electron: string, dshBin: string, omdBin: string, platform?: string }} o
 * @returns {string[]} files written
 */
function writeShims({ bin, electron, dshBin, omdBin, platform = process.platform }) {
  fs.mkdirSync(bin, { recursive: true })
  const win = platform === 'win32'
  const args = win ? '%*' : '"$@"'
  const make = (name, target) => {
    const file = path.join(bin, win ? `${name}.cmd` : name)
    fs.writeFileSync(file, win ? winShim(electron, `${target} ${args}`) : unixShim(electron, `${target} ${args}`), { mode: 0o755 })
    return file
  }
  return [make('node', ''), make('dsh', `"${dshBin}"`), make('omd', `"${omdBin}"`)]
}

/** The environment every child process gets: shims first on PATH, DSH_HOME set, Electron acting as Node, no telemetry prompts. */
function childEnv({ base = process.env, bin, pnpmDir, dshHome, platform = process.platform }) {
  const sep = platform === 'win32' ? ';' : ':'
  const parts = [bin, pnpmDir, base.PATH ?? base.Path ?? ''].filter(Boolean)
  const env = { ...base, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1', PATH: parts.join(sep), NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false' }
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

module.exports = { writeShims, childEnv }

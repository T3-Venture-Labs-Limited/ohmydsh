'use strict'
// DSH, omd and pnpm expect `node`, `dsh` and `pnpm` on PATH. The app has no system Node to lean on: the runtime is either
// a real Node it ships (Linux) or Electron acting as Node (ELECTRON_RUN_AS_NODE=1; see node-runtime.js). We write tiny
// launcher scripts that call it, and put their folder on PATH for every child.
const fs = require('node:fs')
const path = require('node:path')

function unixShim(electron, target, asNode) {
  return `#!/bin/sh\n${asNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec "${electron}" ${target}\n`
}
function winShim(electron, target, asNode) {
  return `@echo off\r\n${asNode ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''}"${electron}" ${target}\r\n`
}

/**
 * @param {{ bin: string, electron: string, dshBin: string, omdBin: string, platform?: string, electronAsNode?: boolean }} o
 *   electron: the executable that runs the scripts; electronAsNode: it is Electron, so the launchers set ELECTRON_RUN_AS_NODE=1
 * @returns {string[]} files written
 */
function writeShims({ bin, electron, dshBin, omdBin, platform = process.platform, electronAsNode = true }) {
  fs.mkdirSync(bin, { recursive: true })
  const win = platform === 'win32'
  const args = win ? '%*' : '"$@"'
  const make = (name, target) => {
    const file = path.join(bin, win ? `${name}.cmd` : name)
    fs.writeFileSync(file, win ? winShim(electron, `${target} ${args}`, electronAsNode) : unixShim(electron, `${target} ${args}`, electronAsNode), { mode: 0o755 })
    return file
  }
  return [make('node', ''), make('dsh', `"${dshBin}"`), make('omd', `"${omdBin}"`)]
}

/** The environment every child process gets: shims first on PATH, DSH_HOME set, no update prompts; ELECTRON_RUN_AS_NODE=1 only when Electron is the Node. */
function childEnv({ base = process.env, bin, pnpmDir, dshHome, platform = process.platform, electronAsNode = true }) {
  const sep = platform === 'win32' ? ';' : ':'
  const parts = [bin, pnpmDir, base.PATH ?? base.Path ?? ''].filter(Boolean)
  const env = { ...base, DSH_HOME: dshHome, PATH: parts.join(sep), NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false' }
  if (electronAsNode) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

module.exports = { writeShims, childEnv }

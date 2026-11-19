'use strict'
// Which executable runs DSH, omd, npm and the `node` shim. Pure function of its inputs, unit-tested without Electron.
//
//   1. OHMYDSH_NODE, when it names an existing file: an override for developers and odd machines.
//   2. The Node the app ships (resources/node/bin/node, Linux only): a real Node, not Electron.
//   3. Electron itself with ELECTRON_RUN_AS_NODE=1 (macOS, Windows, or a Linux build without the bundled Node).
//
// Why Linux ships a Node: Electron's binary loads the system GLib, while sharp's prebuilt libvips brings its own GLib.
// With both in one process the first image job crashes DSH with SIGSEGV (g_object_unref jumping to address 0).
// A plain Node does not load the system GLib, so sharp works.
const fs = require('node:fs')
const nodePath = require('node:path')

/** Where the packaged app keeps its Node, relative to the resources folder. */
function bundledNodePath(resources, platform = process.platform) {
  const path = platform === 'win32' ? nodePath.win32 : nodePath.posix
  return platform === 'win32' ? path.join(resources, 'node', 'node.exe') : path.join(resources, 'node', 'bin', 'node')
}

function isExecutableFile(file, platform = process.platform) {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch { return false }
}

/**
 * @param {object} o
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {string} o.resources     process.resourcesPath of the packaged app (or the dev bundle folder)
 * @param {string} o.execPath      Electron's own executable
 * @param {string} [o.platform]
 * @param {(file: string) => boolean} [o.exists]      OHMYDSH_NODE check (default: the file exists)
 * @param {(file: string) => boolean} [o.executable]  bundled-Node check (default: a regular file with the execute bit)
 * @returns {{ exe: string, kind: 'env' | 'bundled' | 'electron', electronAsNode: boolean, note: string }}
 *   electronAsNode: the child must run with ELECTRON_RUN_AS_NODE=1 (only when `exe` is Electron)
 */
function chooseNodeRuntime({ env = process.env, resources, execPath, platform = process.platform, exists = fs.existsSync, executable = (f) => isExecutableFile(f, platform) }) {
  const pathMod = platform === 'win32' ? nodePath.win32 : nodePath.posix
  let note = ''
  const want = env.OHMYDSH_NODE
  if (want !== undefined && want !== '') {
    const p = pathMod.resolve(want)
    if (exists(p)) return { exe: p, kind: 'env', electronAsNode: false, note: `OHMYDSH_NODE=${p}` }
    note = `OHMYDSH_NODE=${want} does not exist; ignored. `
  }
  if (resources) {
    const bundled = bundledNodePath(resources, platform)
    if (executable(bundled)) return { exe: bundled, kind: 'bundled', electronAsNode: false, note: `${note}bundled Node ${bundled}` }
  }
  return { exe: execPath, kind: 'electron', electronAsNode: true, note: `${note}no bundled Node; the app's Electron acts as Node` }
}

module.exports = { chooseNodeRuntime, bundledNodePath, isExecutableFile }

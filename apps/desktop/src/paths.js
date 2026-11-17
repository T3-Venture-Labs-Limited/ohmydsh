'use strict'
// Where everything lives. Pure functions of (platform, dirs, env) so they are unit-tested without Electron.
const path = require('node:path')

/**
 * @param {{ userData: string, resources: string, appPath: string, env?: NodeJS.ProcessEnv, platform?: string }} o
 * userData: Electron's app.getPath('userData'); resources: process.resourcesPath (packaged) or the apps/desktop folder (dev).
 */
function resolvePaths({ userData, resources, appPath, env = process.env, platform = process.platform }) {
  const dshHome = env.OHMYDSH_DSH_HOME && env.OHMYDSH_DSH_HOME !== '' ? path.resolve(env.OHMYDSH_DSH_HOME) : path.join(userData, 'dsh-home')
  const runtime = path.join(userData, 'runtime')
  return {
    userData,
    dshHome,
    usesOwnHome: !(env.OHMYDSH_DSH_HOME && env.OHMYDSH_DSH_HOME !== ''),
    runtime,
    bin: path.join(runtime, 'bin'),
    logs: path.join(userData, 'logs'),
    settingsFile: path.join(userData, 'settings.json'),
    stateFile: path.join(userData, 'runtime-state.json'),
    // The DSH CLI the runtime installs, and the pnpm executable it needs.
    dshBin: path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    pnpmExe: path.join(runtime, 'node_modules', '@pnpm', `exe.${pnpmTarget(platform, process.arch)}`, platform === 'win32' ? 'pnpm.exe' : 'pnpm'),
    // What ships inside the app: the omd CLI and the manifest it installs from.
    omdBin: path.join(resources, 'ohmydsh', 'packages', 'cli', 'bin', 'omd.js'),
    // OHMYDSH_MANIFEST points the installer at another ohmydsh.json (tests, a release candidate); relative profile/ files resolve next to it.
    manifest: env.OHMYDSH_MANIFEST && env.OHMYDSH_MANIFEST !== '' ? path.resolve(env.OHMYDSH_MANIFEST) : path.join(resources, 'ohmydsh', 'ohmydsh.json'),
    npmTarball: path.join(resources, 'npm.tgz'),
    // npm unpacked by the first run (see runtime.js); it is what installs DSH, run by Electron's Node.
    npmDir: path.join(runtime, 'npm'),
    npmCli: path.join(runtime, 'npm', 'bin', 'npm-cli.js'),
  }
}

/** The @pnpm/exe.<target> package name suffix for a platform/arch (glibc Linux). */
function pnpmTarget(platform, arch) {
  const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
  return `${os}-${arch === 'arm64' ? 'arm64' : 'x64'}`
}

module.exports = { resolvePaths, pnpmTarget }

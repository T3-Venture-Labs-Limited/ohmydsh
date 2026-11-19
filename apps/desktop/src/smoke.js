'use strict'
// Window-less smoke test of everything except the BrowserWindow:
//   ELECTRON_RUN_AS_NODE=1 ohmydsh smoke.js        (the packaged binary, or `electron src/smoke.js`)
// First run provisions DSH + the plugin set exactly like the app does, on the runtime the app picks (OHMYDSH_NODE > the
// Node bundled in the app > Electron as Node; see node-runtime.js), then starts `dsh omd` through the same Supervisor,
// runs a sharp image job under that runtime (the Linux crash regression) and the HTTP checks, stops DSH and exits 0/1.
// OHMYDSH_REQUIRE_BUNDLED_NODE=1 (CI, Linux): fail unless the bundled Node was the one selected.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { resolvePaths } = require('./paths')
const { provision } = require('./runtime')
const { childEnv } = require('./shims')
const { Supervisor } = require('./supervisor')
const { chooseNodeRuntime } = require('./node-runtime')
const { runSharpJob } = require('./sharp-check')
const { runChecks, report } = require('./checks')
const pkg = require('../package.json')

async function main() {
  const userData = path.resolve(process.env.OHMYDSH_USER_DATA ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ohmydsh-smoke-')))
  const packaged = path.basename(path.dirname(process.execPath)) !== 'electron'
  const resources = process.env.OHMYDSH_RESOURCES ?? (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'ohmydsh')) ? process.resourcesPath : path.join(__dirname, '..', 'bundle'))
  const paths = resolvePaths({ userData, resources, appPath: path.join(__dirname, '..') })
  console.log(`ohmydsh ${pkg.version} smoke test: electron ${process.versions.electron} as node ${process.versions.node}, ${process.platform}-${process.arch}${packaged ? '' : ' (dev)'}`)
  console.log(`user data ${userData}; DSH home ${paths.dshHome}`)
  const runtime = chooseNodeRuntime({ resources, execPath: process.execPath })
  console.log(`runtime for DSH: ${runtime.kind} - ${runtime.note}`)
  if (process.env.OHMYDSH_REQUIRE_BUNDLED_NODE === '1' && runtime.kind !== 'bundled') throw new Error(`expected the bundled Node, got ${runtime.kind}: ${runtime.note}`)
  const started = Date.now()
  let lastStep = ''
  await provision({
    paths, electron: runtime.exe, electronAsNode: runtime.electronAsNode, pnpmVersion: pkg.ohmydsh.pnpm,
    progress: (p) => { if (p.step !== lastStep) { lastStep = p.step; console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${p.step}${p.detail ? ` – ${p.detail}` : ''}`) } },
    log: (l) => fs.appendFileSync(path.join(userData, 'smoke-provision.log'), `${l}\n`),
  })
  const env = childEnv({ bin: paths.bin, pnpmDir: path.dirname(paths.pnpmExe), dshHome: paths.dshHome, electronAsNode: runtime.electronAsNode })
  const port = Number(process.env.OHMYDSH_TEST_PORT ?? 43181)
  const lines = []
  const sup = new Supervisor({ electron: runtime.exe, dshBin: paths.dshBin, profile: 'omd', port, host: '127.0.0.1', trustedHosts: [], env, log: (l) => lines.push(l) })
  const ready = new Promise((resolve, reject) => {
    sup.once('ready', resolve)
    sup.once('failed', reject)
    setTimeout(() => reject(new Error(`DSH did not announce a URL within 120 s\n${lines.slice(-15).join('\n')}`)), 120_000).unref()
  })
  sup.start()
  let code = 1
  try {
    const { url } = await ready
    console.log(`  DSH is up on ${new URL(url).origin} after ${Math.round((Date.now() - started) / 1000)} s`)
    const { ok, results } = await runChecks(url, { runtimeNote: runtime.kind, sharp: () => runSharpJob({ exe: runtime.exe, env, nodeModules: path.join(paths.runtime, 'node_modules') }) })
    console.log(report(results, 'checks:'))
    code = ok ? 0 : 1
    console.log(ok ? 'SMOKE TEST OK' : 'SMOKE TEST FAILED')
  } catch (e) {
    console.error(`SMOKE TEST FAILED: ${e.message}`)
  } finally {
    await sup.stop()
    console.log('DSH stopped cleanly')
  }
  process.exit(code)
}

main().catch((e) => { console.error(`SMOKE TEST FAILED: ${e.stack ?? e}`); process.exit(1) })

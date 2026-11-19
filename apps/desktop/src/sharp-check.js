'use strict'
// Regression check for the Linux crash: sharp's first image job segfaulted DSH when the app ran it on Electron-as-Node
// (Electron loads the system GLib, sharp's libvips carries its own). This runs a tiny sharp job (build a 16x16 JPEG,
// decode and resize it to a PNG, read it back) in a child started exactly like the Supervisor starts DSH: same executable, same environment,
// and the sharp DSH itself loads (the one next to @deepseek-ai/dsh-attachment-local in the provisioned runtime).
const { spawn } = require('node:child_process')
const path = require('node:path')

const JOB = `
const { createRequire } = require('node:module')
const dir = process.argv[1]
;(async () => {
let sharp, sharpPkg
for (const from of [dir + '/@deepseek-ai/dsh-attachment-local/package.json', dir + '/package.json']) {
  try { const req = createRequire(from); sharp = req('sharp'); sharpPkg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('node:path').dirname(req.resolve('sharp')), '..', 'package.json'), 'utf8')); break } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e }
}
if (!sharp) throw new Error('sharp is not installed under ' + dir)
  // JPEG decode is the path that segfaults under Electron-as-Node on Linux (metadata() and resize() of a JPEG); a PNG-only job passes there.
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#cc4400' } }).jpeg().toBuffer()
  const small = await sharp(png).resize(4, 4).png().toBuffer()
  const meta = await sharp(small).metadata()
  if (meta.width !== 4 || meta.height !== 4 || meta.format !== 'png') throw new Error('unexpected result ' + JSON.stringify(meta))
  console.log('sharp ' + sharpPkg.version + ' on node ' + process.versions.node + (process.versions.electron ? ' (electron ' + process.versions.electron + ')' : '') + ': 16x16 jpeg (' + png.length + ' B) -> ' + meta.width + 'x' + meta.height + ' png (' + small.length + ' B)')
})().catch((e) => { console.error(String(e && e.message || e).split('\\n')[0]); process.exit(2) })
`

/**
 * @param {{ exe: string, env: NodeJS.ProcessEnv, nodeModules: string, timeoutMs?: number }} o
 * @returns {Promise<string>} what the job printed; rejects when the child crashed, failed or timed out
 */
function runSharpJob({ exe, env, nodeModules, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-e', JOB, path.resolve(nodeModules)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sharp job timed out')) }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not start ${exe}: ${e.message}`)) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const text = out.trim().split(/\r?\n/).slice(0, 4).join(' | ')
      if (code === 0) resolve(text)
      else reject(new Error(`sharp job ${signal ? `was killed by ${signal}` : `exited with ${code}`}${text ? `: ${text}` : ''}`))
    })
  })
}

module.exports = { runSharpJob }

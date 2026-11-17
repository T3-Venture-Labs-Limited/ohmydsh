// Regenerates build/icon.png (1024), icon.ico, icon.icns and the tray icons from the brand app icon. Needs rsvg-convert
// and ImageMagick; the results are committed, so CI does not need them.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const build = join(here, '..', 'build')
const src = join(here, '..', '..', 'android', 'assets-src')
mkdirSync(build, { recursive: true })
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const png = (svg, size, out) => run('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, join(src, svg)])

png('app-icon.svg', 1024, join(build, 'icon.png'))
const sizes = [16, 24, 32, 48, 64, 128, 256]
const tmp = join(build, '.icons'); mkdirSync(tmp, { recursive: true })
for (const s of sizes) png('app-icon.svg', s, join(tmp, `${s}.png`))
run('magick', [...sizes.map((s) => join(tmp, `${s}.png`)), join(build, 'icon.ico')])
// icns: a PNG-based container (ic07 128, ic08 256, ic09 512, ic10 1024), written by hand so no macOS tooling is needed.
const chunks = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([type, s]) => {
  const f = join(tmp, `i${s}.png`); png('app-icon.svg', s, f)
  const data = readFileSync(f); const head = Buffer.alloc(8); head.write(type, 0, 'ascii'); head.writeUInt32BE(data.length + 8, 4)
  return Buffer.concat([head, data])
})
const body = Buffer.concat(chunks); const top = Buffer.alloc(8); top.write('icns', 0, 'ascii'); top.writeUInt32BE(body.length + 8, 4)
writeFileSync(join(build, 'icon.icns'), Buffer.concat([top, body]))
// Tray: the mark alone, 32px (Linux/Windows, coloured) and a monochrome template for macOS.
png('logo.svg', 32, join(build, 'tray.png'))
run('magick', [join(build, 'tray.png'), '-alpha', 'extract', '-background', 'black', '-alpha', 'shape', join(build, 'tray-template.png')])
rmSync(tmp, { recursive: true, force: true })
copyFileSync(join(src, 'lockup.svg'), join(here, '..', 'src', 'assets', 'lockup.svg'))
copyFileSync(join(src, 'lockup-dark.svg'), join(here, '..', 'src', 'assets', 'lockup-dark.svg'))
console.log('icons written to', build)

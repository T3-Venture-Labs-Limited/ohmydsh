// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_BYTES, encodeQr, qrPath, reedSolomon } from '../src/qr/qr.ts'

describe('qr encoder', () => {
  it('Reed-Solomon matches the published HELLO WORLD 1-M vector', () => {
    expect(reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
  })
  it('picks the smallest version and has the three finder patterns', () => {
    expect(encodeQr('hi').version).toBe(1)
    const q = encodeQr('ohmydsh://pair?u=' + 'x'.repeat(60))
    expect(q.size).toBe(17 + 4 * q.version)
    const at = (x: number, y: number): boolean => q.modules[y * q.size + x]!
    for (const [ox, oy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]] as const) {
      for (let i = 0; i < 7; i += 1) { expect(at(ox + i, oy)).toBe(true); expect(at(ox + i, oy + 6)).toBe(true) }
      expect(at(ox + 3, oy + 3)).toBe(true); expect(at(ox + 1, oy + 1)).toBe(false)
    }
  })
  it('is deterministic and rejects payloads over the limit', () => {
    expect(encodeQr('same').modules).toEqual(encodeQr('same').modules)
    expect(() => encodeQr('x'.repeat(MAX_BYTES + 1))).toThrow(/too long/)
    expect(encodeQr('x'.repeat(MAX_BYTES)).version).toBe(10)
  })
  it('renders an svg path with a quiet zone', () => {
    const { path, viewBox } = qrPath(encodeQr('hi'))
    expect(viewBox).toBe('0 0 29 29'); expect(path.startsWith('M4 4')).toBe(true)
  })
  const decoder = spawnSync('zbarimg', ['--version']).status === 0 && spawnSync('rsvg-convert', ['--version']).status === 0
  it.skipIf(!decoder)('an independent decoder (zbarimg) reads codes of several versions back exactly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qr-'))
    try {
      const samples = ['ohmydsh://pair?u=https%3A%2F%2Flaptop.tail1234.ts.net&c=' + 'A'.repeat(22), 'http://192.168.1.23:3080/app/pair#' + 'b'.repeat(22), 'é✓ ünïcode', 'y'.repeat(213)]
      samples.forEach((text, i) => {
        const { path, viewBox } = qrPath(encodeQr(text))
        writeFileSync(join(dir, `${i}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="400" height="400"><rect width="100%" height="100%" fill="#fff"/><path d="${path}"/></svg>`)
        expect(spawnSync('rsvg-convert', [join(dir, `${i}.svg`), '-o', join(dir, `${i}.png`)]).status).toBe(0)
        expect(spawnSync('zbarimg', ['-q', '--raw', join(dir, `${i}.png`)], { encoding: 'utf8' }).stdout.replace(/\n$/, '')).toBe(text)
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

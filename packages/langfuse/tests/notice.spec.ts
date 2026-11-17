// @vitest-environment node
// LF-2 regression: ported MIT code ships with the upstream copyright notice, and NOTICE is in the package.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
describe('LF-2 attribution', () => {
  it('NOTICE credits pi-observability-plugin and keeps the upstream MIT notice', () => {
    const notice = readFileSync(join(root, 'NOTICE'), 'utf8')
    expect(notice).toContain('pi-observability-plugin')
    expect(notice).toContain('Copyright (c) 2026 Langfuse GmbH')
    expect(notice).toContain('Permission is hereby granted, free of charge')
    expect(notice).toMatch(/MIT License/)
  })
  it('NOTICE is listed in package.json "files" and our LICENSE names a real holder', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] }
    expect(pkg.files).toContain('NOTICE')
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2026 Superdao (deestax)')
  })
})

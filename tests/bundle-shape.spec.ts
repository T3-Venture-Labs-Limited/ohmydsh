import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Runs against the last build (`pnpm run build`); skipped when lib/ does not exist yet.
const built = existsSync('lib/client.js') && existsSync('lib/client.workbench.js')

describe.skipIf(!built)('client bundle shape', () => {
  it('keeps the boot bundle small', () => {
    expect(statSync('lib/client.js').size).toBeLessThan(0.5 * 1024 * 1024)
  })

  it('loads the workbench through the module loader instead of a native import', () => {
    const boot = readFileSync('lib/client.js', 'utf8')
    expect(boot).toContain('require.async(`./client.workbench.js`)')
    expect(boot).not.toMatch(/import\(\s*[`'"]\.\/client\.workbench\.js/)
  })

  it('emits the workbench as a self-contained chunk', () => {
    const chunk = readFileSync('lib/client.workbench.js', 'utf8')
    expect(chunk.includes('chunk:`client.workbench.js`')).toBe(true)
    expect(chunk).not.toMatch(/\brequire\((["'`])\.\/client[^"'`]*\1\)/)
    const externals = [...chunk.matchAll(/\brequire\((["'`])([^"'`]+)\1\)/g)].map(match => match[2])
    for (const name of externals) expect(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']).toContain(name)
  })

  it('emits no canvas chunk', () => {
    expect(existsSync('lib/client.canvas.js')).toBe(false)
  })
})

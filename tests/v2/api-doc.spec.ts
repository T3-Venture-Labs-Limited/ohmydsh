import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ROUTE_BASE } from '../../src/v2/routes/index.js'
import { createV2Handler } from '../../src/v2/routes/index.js'

const doc = readFileSync(new URL('../../docs/API.md', import.meta.url), 'utf8')
const routesSource = ['assets', 'jobs', 'models', 'index', 'agent-media'].map(n => readFileSync(new URL(`../../src/v2/routes/${n}.ts`, import.meta.url), 'utf8')).join('\n')

describe('docs/API.md stays in sync with the routes', () => {
  it('names the base path and every route literal the handlers implement', () => {
    expect(doc).toContain(ROUTE_BASE)
    const literals = [...routesSource.matchAll(/path === '(\/[a-z/:-]*)'/g)].map(m => m[1]!).filter(p => !p.includes(':'))
    expect(literals.length).toBeGreaterThan(8)
    for (const path of new Set(literals)) expect(doc, `route ${path} is not documented`).toContain(path)
    expect(typeof createV2Handler).toBe('function')
  })
})

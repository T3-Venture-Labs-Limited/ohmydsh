import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { describe, expect, it } from 'vitest'
import * as parallelPlugin from '../src/index.ts'

const apiKey = process.env.PARALLEL_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('PARALLEL_API_KEY must be present for the single guarded live attempt')
}

describe('Parallel fetch provider real API', () => {
  it('extracts a small public page as markdown in one attempt', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'parallel' })
    await ctx.plugin(parallelPlugin, {})

    const result = await ctx.web.fetch({ url: 'https://example.com' })

    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    expect(result.body.content).toContain('documentation examples')
    expect(result.truncated).toBe(false)

    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      status: 'passed',
      contentLength: result.body.content.length,
    })}\n`)
  }, 70_000)
})

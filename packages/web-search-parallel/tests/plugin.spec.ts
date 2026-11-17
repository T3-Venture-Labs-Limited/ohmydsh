import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import WebRuntime from '@deepseek-ai/dsh-web'
import Parallel from 'parallel-web'
import { readFileSync } from 'node:fs'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as parallelPlugin from '../src/index.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

function mockSearch(results: Array<{
  url: string
  excerpts: string[]
  title?: string | null
  publish_date?: string | null
}> = []) {
  return vi.spyOn(Parallel.prototype, 'search').mockResolvedValue({
    results,
    search_id: 'search_test',
    session_id: 'session_test',
  })
}

describe('Parallel bundle patch row', () => {
  it('pins both web providers in one row so a same-id replace cannot drop either', () => {
    const patch = yaml.load(
      readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
      { schema: entryListSchema },
    ) as Array<Record<string, unknown>>
    const rows = patch.filter(row => row.id === 'web')
    expect(rows).toEqual([{
      id: 'web',
      name: '@deepseek-ai/dsh-web',
      config: { searchProvider: 'parallel', fetchProvider: 'parallel' },
    }])
  })
})

describe('Parallel plugin config', () => {
  it('accepts a fetch character cap and rejects invalid ones', () => {
    expect(parallelPlugin.Config({ maxFetchChars: 5_000 })).toMatchObject({ maxFetchChars: 5_000 })
    for (const value of [0, -1, 1.5]) {
      expect(() => parallelPlugin.Config({ maxFetchChars: value })).toThrow()
    }
  })

  it('materializes the default total character budget in the schema', () => {
    expect(parallelPlugin.Config({})).toEqual({
      maxCharsTotal: parallelPlugin.DEFAULT_MAX_CHARS_TOTAL,
    })
  })

  it('preserves an explicit total character budget override', () => {
    expect(parallelPlugin.Config({ maxCharsTotal: 4_000 })).toEqual({ maxCharsTotal: 4_000 })
  })

  it.each(['turbo', 'basic', 'advanced'])('accepts documented mode %s', mode => {
    expect(parallelPlugin.Config({ mode: mode as NonNullable<parallelPlugin.Config['mode']> })).toEqual({
      mode,
      maxCharsTotal: parallelPlugin.DEFAULT_MAX_CHARS_TOTAL,
    })
  })

  it.each(['fast', 'auto', ''])('rejects unsupported mode %j', mode => {
    expect(() => parallelPlugin.Config({ mode } as unknown as parallelPlugin.Config)).toThrow()
  })

  it.each([0, -1, 1.5])('rejects invalid character budget %s', value => {
    expect(() => parallelPlugin.Config({ maxCharsTotal: value })).toThrow()
    expect(() => parallelPlugin.Config({ maxCharsPerResult: value })).toThrow()
  })
})

function mockExtract(result: Record<string, unknown> = { full_content: 'page body' }) {
  return vi.spyOn(Parallel.prototype, 'extract').mockResolvedValue({
    results: [{ url: 'https://example.test/', excerpts: [], ...result }],
    errors: [],
    extract_id: 'extract_test',
    session_id: 'session_test',
  } as never)
}

describe('Parallel plugin registration', () => {
  it('registers both providers, lists them, and selects parallel for each', async () => {
    mockSearch()
    const extract = mockExtract({ title: 'T', full_content: 'page body' })
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel', fetchProvider: 'parallel' })
    const fiber = await ctx.plugin(parallelPlugin, { apiKey: 'parallel_test_plugin' })
    expect(ctx.web.listProviders()).toMatchObject({
      search: [{ id: 'parallel' }],
      fetch: [{ id: 'parallel' }],
    })
    await expect(ctx.web.fetch({ url: 'https://example.test/' })).resolves.toMatchObject({
      statusCode: 200,
      body: { kind: 'text', content: 'page body' },
    })
    expect(extract).toHaveBeenCalledOnce()
    expect(extract.mock.calls[0]?.[0]).toEqual({
      urls: ['https://example.test/'],
      advanced_settings: { full_content: true },
    })
    await fiber.dispose()
    expect(ctx.web.listProviders()).toMatchObject({ search: [], fetch: [] })
    await expect(ctx.web.fetch({ url: 'https://example.test/' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('fetch provider is unavailable without a key and makes no network call', async () => {
    const extract = mockExtract()
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
    await ctx.plugin(WebRuntime, { fetchProvider: 'parallel' })
    await ctx.plugin(parallelPlugin, {})
    await expect(ctx.web.fetch({ url: 'https://example.test/' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    expect(extract).not.toHaveBeenCalled()
  })

  it('uses the launch-environment key for fetch', async () => {
    const extract = mockExtract()
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{
      source: 'process',
      values: { PARALLEL_API_KEY: 'parallel_test_environment' },
    }]))
    await ctx.plugin(WebRuntime, { fetchProvider: 'parallel' })
    await ctx.plugin(parallelPlugin, {})
    await ctx.web.fetch({ url: 'https://example.test/' })
    expect(extract).toHaveBeenCalledOnce()
  })

  it('registers, selects, and disposes through the real WebRuntime', async () => {
    mockSearch()
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' })
    const fiber = await ctx.plugin(parallelPlugin, { apiKey: 'parallel_test_plugin' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toEqual({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('uses the launch-environment fallback', async () => {
    const search = mockSearch()
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{
      source: 'process',
      values: { PARALLEL_API_KEY: 'parallel_test_environment' },
    }]))
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' })
    await ctx.plugin(parallelPlugin, {})
    await ctx.web.search({ query: 'q' })
    expect(search).toHaveBeenCalledOnce()
  })

  it('lets an explicit empty key suppress environment fallback', async () => {
    const search = mockSearch()
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{
      source: 'process',
      values: { PARALLEL_API_KEY: 'parallel_test_environment' },
    }]))
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' })
    await ctx.plugin(parallelPlugin, { apiKey: '' })
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    expect(search).not.toHaveBeenCalled()
  })

  it('is unavailable without a key and makes no network call', async () => {
    const search = mockSearch()
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' })
    await ctx.plugin(parallelPlugin, {})
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    expect(search).not.toHaveBeenCalled()
  })

  it('lets the seam own final source truncation', async () => {
    mockSearch([
      { url: 'https://a.test', excerpts: ['a'] },
      { url: 'https://b.test', excerpts: ['b'] },
      { url: 'https://c.test', excerpts: ['c'] },
    ])
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'parallel' })
    await ctx.plugin(parallelPlugin, { apiKey: 'parallel_test_plugin' })
    await expect(ctx.web.search({ query: 'q', maxResults: 2 })).resolves.toMatchObject({
      sources: [{ url: 'https://a.test' }, { url: 'https://b.test' }],
      truncated: true,
    })
  })

  it('has a namespace export surface without fetch functions', () => {
    expect('default' in parallelPlugin).toBe(false)
    expect('fetch' in parallelPlugin).toBe(false)
    expect('registerFetchProvider' in parallelPlugin).toBe(false)
    expect(parallelPlugin.PARALLEL_PROVIDER_ID).toBe('parallel')
  })
})

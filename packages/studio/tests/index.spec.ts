import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index.js'
import { IMAGE_ROUTE, SETTINGS_HEALTH_ROUTE, TEST_CONNECTION_ROUTE } from '../src/shared.js'
import { ROUTE_BASE } from '../src/v2/routes/index.js'

function harnessContext(options: { webServer?: boolean } = {}): { ctx: Context; tools: ToolDefinition[]; routes: { kind: string; path: string }[] } {
  const tools: ToolDefinition[] = []
  const routes: { kind: string; path: string }[] = []
  const hasWebServer = options.webServer ?? true
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool) } },
    effect: (setup: () => unknown) => setup(),
    ...(hasWebServer ? { webServer: { register: vi.fn((route: { kind: string; path: string }) => { routes.push(route); return () => {} }) } } : {}),
    credentials: { resolve: vi.fn(async () => undefined) },
    inject: (services: readonly string[], callback: (owner: unknown) => void) => {
      if (services.includes('webServer')) { if (hasWebServer) callback(ctx); return }
      if (services.includes('settings')) callback({ settings: { installSection: vi.fn() } })
    },
    attachments: { imageLimits: { maxImageBytes: 10 * 1024 * 1024, mediaTypes: ['image/png'] }, readImage: vi.fn(), saveImage: vi.fn() },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as Context
  return { ctx, tools, routes }
}

describe('plugin surface after the v1 retirement', () => {
  it('registers exactly the four v2 tools; the retired generation and canvas tools are gone', () => {
    const { ctx, tools } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    expect(tools.map(tool => tool.name).sort()).toEqual(['studio_gallery', 'studio_job', 'studio_make', 'studio_models'])
  })

  it('does not require webServer, so headless, acp and sdk profiles can activate it', async () => {
    const plugin = await import('../src/index.js')
    expect(plugin.inject).not.toContain('webServer')
    const { ctx, tools, routes } = harnessContext({ webServer: false })
    expect(() => apply(ctx, { saveToWorkspace: false })).not.toThrow()
    expect(tools.length).toBeGreaterThan(0); expect(routes).toEqual([])
  })

  it('mounts only the kept v1 routes plus the v2 prefix route, each exactly once', () => {
    const { ctx, routes } = harnessContext()
    apply(ctx, { provider: 'google', saveToWorkspace: false })
    const paths = routes.map(route => route.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const kept of [IMAGE_ROUTE, SETTINGS_HEALTH_ROUTE, TEST_CONNECTION_ROUTE, ROUTE_BASE]) expect(paths, `missing ${kept}`).toContain(kept)
    expect(routes.find(route => route.path === ROUTE_BASE)?.kind).toBe('prefix')
    const retired = ['studio', 'thumb', 'preview', 'import', 'delete', 'save-workspace', 'zip', 'zip/progress', 'zip/cancel', 'vault', 'vault-refs', 'vault-delete', 'storage-stats']
    for (const name of retired) expect(paths, `retired route ${name} is still mounted`).not.toContain(`/plugins/dsh-studio/${name}`)
    // everything we mount lives under our own prefix
    for (const path of paths) expect(path.startsWith('/plugins/dsh-studio/') || path.startsWith('/plugins/dsh-studio')).toBe(true)
  })
})

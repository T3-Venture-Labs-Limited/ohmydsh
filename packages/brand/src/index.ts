/**
 * Host half. Everything the page needs before any script runs, through DSH's own extension points:
 *   - `webserver/index-inject` rows: the plugin configuration for the client half, and the boot-splash script;
 *   - `webServer.tapIndex`: the stock index.html's <title>, installed-app title and (cache-busted) icon links;
 *   - exact routes for the stock icon paths (favicon.svg, favicon-dark.svg, apple-touch-icon.png, icon-192/512,
 *     icon-maskable-512). The same paths the installed-app manifest uses, so the phone app icon follows too.
 * The routes are public static files (as the stock ones are) and hold nothing secret. With `enabled: false` nothing
 * is registered. Every registration goes through `ctx.effect` / `ctx.on`, so disabling the plugin removes it all.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { iconHandler, packageRoot } from './host/assets.ts'
import { readConfig } from './shared/config.ts'
import { ICON_PATHS, brandIndex, brandRows } from './shared/index-html.ts'

export const name = '@t3labs/ohmydsh-brand'
export const inject = ['webServer']

interface Route { kind: 'exact'; path: string; handler: (req: never, res: never) => void | Promise<void> }
interface Ctx {
  effect(fn: () => unknown, label?: string): void
  on(event: string, fn: (...args: never[]) => unknown): () => void
  webServer: { register(route: Route): () => void; tapIndex(transform: (html: string) => string): () => void }
}

function version(): string {
  try { return (JSON.parse(readFileSync(resolve(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version } catch { return '0' }
}

export function apply(ctx: Context, rawConfig?: unknown): void {
  const c = ctx as unknown as Ctx
  const config = readConfig(rawConfig)
  const v = version()
  // The client half reads its configuration from the page (a global row), so the settings row is the single source.
  c.on('webserver/index-inject', ((table: { push(row: unknown): void }) => { for (const row of brandRows(config)) table.push(row) }) as never)
  if (!config.enabled) return
  c.effect(() => c.webServer.tapIndex((html) => brandIndex(html, v)), 'ohmydsh-brand: index title and icon links')
  for (const path of ICON_PATHS) {
    const handler = iconHandler(path)
    c.effect(() => c.webServer.register({ kind: 'exact', path, handler: handler as never }), `ohmydsh-brand: ${path}`)
  }
}

/**
 * Host half. The only thing the page needs from the host is this plugin's settings row, which the client half reads as a
 * page global (`webserver/index-inject`, the same mechanism ohmydsh-brand uses). Everything else is browser-side.
 * Registered through `ctx.on`, so disabling the plugin removes it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { GLOBAL_NAME, readConfig } from './shared/config.ts'

export const name = '@t3labs/ohmydsh-keys'
export const inject = ['webServer']

interface Ctx {
  on(event: string, fn: (...args: never[]) => unknown): () => void
}

export function apply(ctx: Context, rawConfig?: unknown): void {
  const config = readConfig(rawConfig)
  ;(ctx as unknown as Ctx).on('webserver/index-inject', ((table: { push(row: unknown): void }) => {
    table.push({ kind: 'global', name: GLOBAL_NAME, value: { enabled: config.enabled, autoFocus: config.autoFocus } })
  }) as never)
}

/**
 * Host half. Register every resource with `ctx.effect` / `ctx.on` so unload disposes it
 * (e.g. routes, tools, system-prompt sections). Browser UI lives in src/client.
 * Host routes must call `connection.requestRejection(request)` and fail closed.
 */
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  void ctx
}

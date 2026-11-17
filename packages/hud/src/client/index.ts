// Browser half: "Open in web" from the HUD lands on `/#dsh-hud-session=<id>`; select that session once the
// workspace UI is ready, then clear the fragment. No polling: it reacts to load and hashchange, and retries a few
// times while the session list is still mounting.
import type { Context } from '@deepseek-ai/cordis'

const KEY = 'dsh-hud-session='
const RETRIES = [0, 400, 1200, 3000]

export function apply(ctx: Context): void {
  const open = (): boolean => {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ''))
    if (!hash.startsWith(KEY)) return true
    const sessionId = hash.slice(KEY.length)
    if (!/^[\w.:-]{1,200}$/.test(sessionId)) return true
    const workspace = ctx.get('uiWorkspace' as never) as { openSession(id: string): void } | undefined
    if (workspace === undefined) return false
    workspace.openSession(sessionId)
    history.replaceState(null, '', window.location.pathname + window.location.search)
    return true
  }
  ctx.effect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const run = (index: number): void => {
      if (open() || index + 1 >= RETRIES.length) return
      timers.push(setTimeout(() => { run(index + 1) }, (RETRIES[index + 1] ?? 0) - (RETRIES[index] ?? 0)))
    }
    const onHash = (): void => { run(0) }
    window.addEventListener('hashchange', onHash)
    run(0)
    return () => { window.removeEventListener('hashchange', onHash); timers.forEach(clearTimeout) }
  }, 'dsh-hud: open-in-web')
}

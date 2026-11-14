// Plugin-wide runtime facts the DOM adapters need but cannot derive from the DOM alone.
// Set once in apply(); every reader degrades gracefully when a value is missing.
import type { Ctx } from './host.ts'

const FLAG_KEY = 'dsh-review-comments:better-sidebar'
/** better-sidebar versions whose editor DOM was checked by hand (docs/DETAIL.md). */
const SUPPORTED = { min: [0, 19, 0], maxExclusive: [0, 40, 0] } as const

interface TabInventory { getSnapshot(): readonly { sessionId: string; tabId: string; kind: string; contentId: string }[] }

let current: Ctx | undefined
let warned = false

export const runtime = {
  set(ctx: Ctx | undefined): void { current = ctx; warned = false },

  /** Feature flag, default on. Off with `localStorage['dsh-review-comments:better-sidebar'] = 'off'`. */
  flagOn(): boolean {
    try { return localStorage.getItem(FLAG_KEY) !== 'off' } catch { return true }
  },

  /** better-sidebar's own version when its service is installed (undefined = not installed or unknown). */
  betterSidebarVersion(): string | undefined {
    try { return (current?.get('betterSidebar') as { version?: string } | undefined)?.version } catch { return undefined }
  },

  /** On when the flag is on and the installed better-sidebar is inside the verified window (unknown version still allowed: markers gate it). */
  betterSidebarEnabled(): boolean {
    if (!runtime.flagOn()) return false
    const version = runtime.betterSidebarVersion()
    if (version === undefined) return true
    const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => Number.parseInt(part, 10))
    const v = [major, minor, patch]
    const cmp = (a: readonly number[], b: readonly number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!
    const ok = cmp(v, SUPPORTED.min) >= 0 && cmp(v, SUPPORTED.maxExclusive) < 0
    if (!ok && !warned) { warned = true; console.info(`[dsh-review-comments] better-sidebar ${version} is outside the verified range; its viewers are left alone.`) }
    return ok
  },

  /** The resource address a sidebar tab shows, from the public tab inventory. */
  addressOfTab(tabId: string): string | undefined {
    try {
      const face = current?.get('sidebarRight') as { openTabs?: TabInventory } | undefined
      return face?.openTabs?.getSnapshot().find(tab => tab.tabId === tabId)?.contentId
    } catch { return undefined }
  },

  ctx(): Ctx | undefined { return current },
}

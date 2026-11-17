// Builds the manager's view: scan entries + the registry's winners (plugin-provided skills) + DSH-only state + usage.
import type { ScanEntry } from './scanner.ts'
import { stateOf, type DisabledState, type Settings } from './store.ts'
import type { UsageStat } from './usage.ts'

export interface RegistrySummary { name: string; description?: string; path?: string; source?: string; provider?: string; invocation?: { modelInvocable?: boolean; userInvocable?: boolean } }

export type SkillState = 'active' | 'shadowed' | 'invalid'

export interface SkillRow {
  id: string
  name: string
  description: string
  /** Where it comes from: a filesystem root source, or `plugin` for registry-only providers. */
  source: string
  provider?: string
  path?: string
  realPath?: string
  symlink: boolean
  layout?: 'folder' | 'flat'
  dirName?: string
  editable: boolean
  readOnlyReason?: 'system' | 'permission' | 'plugin' | 'outside-root'
  state: SkillState
  shadowedBy?: { source: string; path?: string }
  shadows: number
  errors: number
  warnings: number
  wouldLoad: boolean
  modelInvocable: boolean
  userInvocable: boolean
  /** Name-level DSH state for the selected workspace. */
  disabled: DisabledState
  size?: number
  mtimeMs?: number
  usage?: UsageStat
}

export function buildRows(input: {
  scan: readonly ScanEntry[]
  winners: readonly RegistrySummary[] | undefined
  settings: Settings
  projectRoot: string | undefined
  usage: Readonly<Record<string, UsageStat>>
}): SkillRow[] {
  const { scan, winners, settings, projectRoot, usage } = input
  const byWinnerPath = new Map<string, RegistrySummary>()
  for (const w of winners ?? []) if (w.path !== undefined) byWinnerPath.set(w.path, w)
  // Winner per name from our scan (rank order) when the registry is unavailable or knows nothing about a name.
  const scanWinner = new Map<string, ScanEntry>()
  for (const e of [...scan].filter(x => x.wouldLoad && x.name !== undefined).sort((a, b) => a.rank - b.rank)) {
    if (!scanWinner.has(e.name!)) scanWinner.set(e.name!, e)
  }
  const winnerOfName = new Map<string, { source: string; path?: string }>()
  for (const w of winners ?? []) winnerOfName.set(w.name, { source: w.source ?? 'plugin', ...(w.path === undefined ? {} : { path: w.path }) })
  const rows: SkillRow[] = []
  const scannedPaths = new Set<string>()
  const shadowCount = new Map<string, number>()
  for (const e of scan) {
    scannedPaths.add(e.realPath)
    if (!e.wouldLoad || e.name === undefined) continue
    const isWinner = winners !== undefined
      ? byWinnerPath.get(e.realPath) !== undefined && byWinnerPath.get(e.realPath)!.name === e.name
      : scanWinner.get(e.name) === e
    if (!isWinner) shadowCount.set(e.name, (shadowCount.get(e.name) ?? 0) + 1)
  }
  for (const e of scan) {
    const errors = e.issues.filter(i => i.level === 'error').length
    const warnings = e.issues.length - errors
    const name = e.name ?? e.dirName
    let state: SkillState = 'active'
    let shadowedBy: SkillRow['shadowedBy']
    if (!e.wouldLoad) state = 'invalid'
    else {
      const win = winners !== undefined
        ? byWinnerPath.get(e.realPath)?.name === e.name
        : scanWinner.get(e.name!) === e
      if (!win) {
        state = 'shadowed'
        const by = winnerOfName.get(e.name!) ?? (scanWinner.get(e.name!) === undefined ? undefined : { source: scanWinner.get(e.name!)!.source, path: scanWinner.get(e.name!)!.path })
        if (by !== undefined) shadowedBy = by
      }
    }
    rows.push({
      id: e.id, name, description: e.description ?? '', source: e.source, path: e.path, realPath: e.realPath, symlink: e.symlink || e.path !== e.realPath,
      layout: e.layout, dirName: e.dirName, editable: e.writable, ...(e.readOnlyReason === undefined ? {} : { readOnlyReason: e.readOnlyReason }),
      state, ...(shadowedBy === undefined ? {} : { shadowedBy }), shadows: state === 'active' ? (shadowCount.get(name) ?? 0) : 0,
      errors, warnings, wouldLoad: e.wouldLoad, modelInvocable: e.modelInvocable, userInvocable: e.userInvocable,
      disabled: stateOf(settings, name, projectRoot), size: e.size, mtimeMs: e.mtimeMs, ...(usage[name] === undefined ? {} : { usage: usage[name] }),
    })
  }
  // Registry winners no scan root owns: plugin-bundled / runtime / preset-bundled skills. Disable-only.
  for (const w of winners ?? []) {
    if (w.path !== undefined && scannedPaths.has(w.path)) continue
    rows.push({
      id: `plugin:${w.name}`, name: w.name, description: w.description ?? '', source: 'plugin', ...(w.provider === undefined ? {} : { provider: w.provider }),
      ...(w.path === undefined ? {} : { path: w.path }), symlink: false, editable: false, readOnlyReason: 'plugin', state: 'active', shadows: 0, errors: 0, warnings: 0,
      wouldLoad: true, modelInvocable: w.invocation?.modelInvocable !== false, userInvocable: w.invocation?.userInvocable !== false,
      disabled: stateOf(settings, w.name, projectRoot), ...(usage[w.name] === undefined ? {} : { usage: usage[w.name] }),
    })
  }
  const order: Record<SkillState, number> = { active: 0, shadowed: 1, invalid: 2 }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || order[a.state] - order[b.state])
}

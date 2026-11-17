// DSH-only state (never inside any skill root): which skills DSH hides, globally or per workspace.
// Evolution (proposals, review cursor, ledger) will live beside this file under the same directory.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface WorkspaceOverride { disable: string[]; enable: string[] }
export interface Settings {
  version: 1
  /** Skill names hidden everywhere in DSH. */
  disabled: string[]
  /** Per project root (absolute): extra names to hide here, or names to re-enable here despite a global disable. */
  workspaces: Record<string, WorkspaceOverride>
}

export function emptySettings(): Settings {
  return { version: 1, disabled: [], workspaces: {} }
}

export function normalizeSettings(input: unknown): Settings {
  const s = emptySettings()
  if (typeof input !== 'object' || input === null) return s
  const r = input as { disabled?: unknown; workspaces?: unknown }
  const names = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [])
  s.disabled = names(r.disabled)
  if (typeof r.workspaces === 'object' && r.workspaces !== null) {
    for (const [root, value] of Object.entries(r.workspaces as Record<string, unknown>)) {
      const o = (typeof value === 'object' && value !== null ? value : {}) as { disable?: unknown; enable?: unknown }
      const entry = { disable: names(o.disable), enable: names(o.enable) }
      if (entry.disable.length + entry.enable.length > 0) s.workspaces[root] = entry
    }
  }
  return s
}

export type DisabledState = 'enabled' | 'disabled-global' | 'disabled-workspace' | 'enabled-workspace'

/** Effective state of `name` in the workspace rooted at `projectRoot` (or globally when undefined). */
export function stateOf(settings: Settings, name: string, projectRoot: string | undefined): DisabledState {
  const ws = projectRoot === undefined ? undefined : settings.workspaces[projectRoot]
  const global = settings.disabled.includes(name)
  if (ws?.enable.includes(name) === true && global) return 'enabled-workspace'
  if (ws?.disable.includes(name) === true) return 'disabled-workspace'
  return global ? 'disabled-global' : 'enabled'
}

export const isHidden = (state: DisabledState): boolean => state === 'disabled-global' || state === 'disabled-workspace'

export class SettingsStore {
  private current: Settings = emptySettings()
  private writing: Promise<void> = Promise.resolve()
  readonly file: string

  constructor(readonly dir: string) {
    this.file = join(dir, 'settings.json')
  }

  get settings(): Settings { return this.current }

  async load(): Promise<void> {
    try { this.current = normalizeSettings(JSON.parse(await readFile(this.file, 'utf8'))) } catch { this.current = emptySettings() }
  }

  /** Apply `mutate` to a copy, publish it immediately (so the filter obeys at once), then persist atomically. */
  async update(mutate: (draft: Settings) => void): Promise<Settings> {
    const draft = structuredClone(this.current)
    mutate(draft)
    this.current = normalizeSettings(draft)
    const snapshot = JSON.stringify(this.current, null, 2)
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${String(process.pid)}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, this.file)
    })
    await this.writing
    return this.current
  }
}

/** Set one skill's disabled state. `scope` 'global' edits the global list; a project root edits that workspace override. */
export function applyToggle(draft: Settings, name: string, hide: boolean, scope: 'global' | { workspace: string }): void {
  const without = (list: string[]): string[] => list.filter(n => n !== name)
  if (scope === 'global') {
    draft.disabled = hide ? [...without(draft.disabled), name] : without(draft.disabled)
    return
  }
  const ws = draft.workspaces[scope.workspace] ?? { disable: [], enable: [] }
  const global = draft.disabled.includes(name)
  ws.disable = without(ws.disable)
  ws.enable = without(ws.enable)
  if (hide && !global) ws.disable.push(name)
  if (!hide && global) ws.enable.push(name)
  draft.workspaces[scope.workspace] = ws
}

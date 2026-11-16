/**
 * Per-turn pin for trigger-started turns (port of dsh-composio pin.ts).
 *
 * Event text is third-party data. While a trigger-started turn runs we
 *   1. install a tool guard that only lets read-only tools through (tools: 'read'),
 *   2. optionally pin the session sandbox to the automation's mode, never looser than what the session already has.
 * Both are lifted on the next human (`source.kind === 'user'`) inbox claim. The mode to restore is persisted in
 * `$DSH_HOME/triggers/pins.json`, so a restart or an idle unload in between cannot leave the session stuck pinned.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type Mode = 'read-only' | 'workspace-write' | 'danger-full-access'
const RANK: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

/** The stricter of two modes (unknown strings count as the loosest, so they never win). */
export function stricter(a: string, b: string): Mode {
  return ((RANK[a] ?? 3) <= (RANK[b] ?? 3) ? a : b) as Mode
}

/** Tools a guarded trigger turn may use. */
export const READ_TOOLS: readonly string[] = ['read', 'glob', 'grep', 'skill', 'read_image', 'todo_write', 'web_search', 'web_fetch', 'ask_user_question', 'present']
export const readToolGuard = (exec: { name: string }): string | undefined =>
  (READ_TOOLS.includes(exec.name) ? undefined : `${exec.name} is not available in a turn started by a trigger (read-only tools only: ${READ_TOOLS.join(', ')}). The user can lift this by sending a message.`)

export interface PinPolicy {
  /** Tighten the session to this mode for the turn (restored on the next human turn). Omit to leave the mode alone. */
  sandbox?: 'read-only' | 'workspace-write' | undefined
  /** Install the read-only tool guard. */
  guard: boolean
}

export interface PinnableAgent {
  readonly id: string
  readonly ctx: { tools: { guard(g: (exec: { name: string }) => string | undefined): () => void }; effect(fn: () => () => void, label?: string): unknown }
  readonly session: { append(type: string, data: unknown): unknown }
}

export interface PinDeps {
  /** Effective sandbox mode of the agent's session right now. `undefined` = cannot tell (a sandbox pin then refuses). */
  currentMode: (agent: PinnableAgent) => string | undefined
  guard?: ((exec: { name: string }) => string | undefined) | undefined
  log: { info(m: string): void; warn(m: string): void }
  persist?: PinStore | undefined
}

interface Active { unguard: (() => void) | undefined; restoreMode: string | undefined; pinnedMode: string | undefined; sessionId: string }

export class PinError extends Error {}

export class TurnPins {
  private readonly active = new Map<string, Active>()
  private pending: Record<string, string> = {}

  constructor(private readonly deps: PinDeps) {}

  async load(): Promise<void> { this.pending = { ...(await this.deps.persist?.load()), ...this.pending } }

  has(agentId: string): boolean { return this.active.has(agentId) }
  guarded(agentId: string): boolean { return this.active.get(agentId)?.unguard !== undefined }

  /** Pin the agent for trigger-started turn(s). Idempotent: a second call only tightens. Throws PinError when it cannot be made safe. */
  apply(agent: PinnableAgent, sessionId: string, policy: PinPolicy): void {
    const now = policy.sandbox === undefined ? undefined : this.deps.currentMode(agent)
    if (policy.sandbox !== undefined && now === undefined) throw new PinError('The target chat sandbox mode is unknown; refusing to deliver untrusted event text into it.')
    let entry = this.active.get(agent.id)
    if (entry === undefined) {
      entry = { unguard: undefined, restoreMode: undefined, pinnedMode: undefined, sessionId }
      this.active.set(agent.id, entry)
      agent.ctx.effect(() => () => { this.active.delete(agent.id) }, 'triggers: pin cleanup')
    }
    if (policy.guard && entry.unguard === undefined) {
      const target = entry
      let done = false
      agent.ctx.effect(() => {
        const dispose = agent.ctx.tools.guard(this.deps.guard ?? readToolGuard)
        const off = (): void => { if (!done) { done = true; dispose() } }
        target.unguard = off
        return off
      }, 'triggers: trigger-turn tool guard')
    }
    if (policy.sandbox !== undefined && now !== undefined) {
      const target = stricter(now, policy.sandbox)
      if (target !== now) {
        if (entry.restoreMode === undefined) {
          entry.restoreMode = now
          this.pending[sessionId] = now
          void this.deps.persist?.save(this.pending)
        }
        entry.pinnedMode = target
        agent.session.append('sandbox/mode', { mode: target })
      }
    }
  }

  /** A human spoke: drop the guard, restore the session's previous sandbox mode. */
  lift(agent: PinnableAgent): void {
    const entry = this.active.get(agent.id)
    if (entry === undefined) return
    this.active.delete(agent.id)
    entry.unguard?.()
    if (entry.restoreMode === undefined || entry.pinnedMode === undefined) return
    // If the user changed the mode themselves while the pin was on, their choice wins.
    const now = this.deps.currentMode(agent)
    if (now !== undefined && now !== entry.pinnedMode) { delete this.pending[entry.sessionId]; void this.deps.persist?.save(this.pending); return }
    this.restore(agent, entry.sessionId, entry.restoreMode)
  }

  /** `agent/inbox/claimed`: a human turn ends the pin. */
  onClaimed(agent: PinnableAgent, message: { source?: { kind?: string } }): void {
    if (message.source?.kind === 'user') this.lift(agent)
  }

  /** `agent/created`: a sandbox pin left behind by a previous process (or an unloaded agent) is undone. */
  onCreated(agent: PinnableAgent, sessionId: string): void {
    if (this.active.has(agent.id)) return
    const previous = this.pending[sessionId]
    if (previous !== undefined) this.restore(agent, sessionId, previous)
  }

  private restore(agent: PinnableAgent, sessionId: string, mode: string): void {
    try {
      agent.session.append('sandbox/mode', { mode })
    } catch (error) {
      this.deps.log.warn(`triggers: could not restore the sandbox mode of ${sessionId}: ${String(error)}`)
      return
    }
    delete this.pending[sessionId]
    void this.deps.persist?.save(this.pending)
  }
}

/** `sessionId -> mode to restore` (0600, atomic). */
export class PinStore {
  private writing: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}
  async load(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] in RANK))
    } catch { return {} }
  }
  save(data: Record<string, string>): Promise<void> {
    const snapshot = JSON.stringify(data)
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const tmp = `${this.path}.tmp`
        await writeFile(tmp, snapshot, { mode: 0o600 })
        await rename(tmp, this.path)
      } catch { /* best effort: the in-memory pin still restores */ }
    })
    return this.writing
  }
  flushed(): Promise<void> { return this.writing }
}

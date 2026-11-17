/**
 * Per-turn pin for a composio-originated turn in an EXISTING session (CO-1).
 *
 * A trigger payload is third-party text (email bodies, issue comments, chat messages). When it is delivered into a
 * normal session the model there has bash, edit, the browser and everything else. So for the turn(s) that carry a
 * composio message we:
 *   1. install a tool guard that only lets `composio_*` and read-only tools through (same guard as new-session runs),
 *   2. pin the session sandbox to the recipe's mode, never looser than what the session already has,
 *   3. install the per-run approval policy for `composio_execute`.
 * All of it is lifted on the next human (`user` source) turn. The previous mode is persisted, so a restart or an idle
 * unload in between cannot leave the session stuck in the pinned mode.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
const RANK: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

/** The stricter of two modes (unknown strings count as the loosest, so they never win). */
export function stricter(a: string, b: string): SandboxMode {
  return ((RANK[a] ?? 3) <= (RANK[b] ?? 3) ? a : b) as SandboxMode
}

export interface RunPolicyLike { allowTools: string[]; allowToolkits: string[] }
export interface PinPolicy extends RunPolicyLike { sandbox: 'read-only' | 'workspace-write' }

/** Merge the policies of several queued deliveries into one batch policy: strictest sandbox, intersection of allowlists. */
export function mergePolicies(list: readonly PinPolicy[]): PinPolicy {
  const first = list[0] as PinPolicy
  let merged: PinPolicy = { sandbox: first.sandbox, allowTools: [...first.allowTools], allowToolkits: [...first.allowToolkits] }
  for (const p of list.slice(1)) {
    merged = {
      sandbox: stricter(merged.sandbox, p.sandbox) as PinPolicy['sandbox'],
      allowTools: merged.allowTools.filter((t) => p.allowTools.includes(t)),
      allowToolkits: merged.allowToolkits.filter((t) => p.allowToolkits.includes(t)),
    }
  }
  return merged
}

export interface PinnableAgent {
  readonly id: string
  readonly ctx: { tools: { guard(g: (exec: { name: string }) => string | undefined): () => void }; effect(fn: () => () => void, label?: string): unknown }
  readonly session: { append(type: string, data: unknown): unknown }
}

export interface PinDeps {
  /** Effective sandbox mode of the agent's session right now. `undefined` = cannot tell (the pin then refuses). */
  currentMode: (agent: PinnableAgent) => string | undefined
  guard: (exec: { name: string }) => string | undefined
  setRunPolicy: (agentId: string, policy: RunPolicyLike | undefined) => void
  log: { info(m: string): void; warn(m: string): void }
  /** Durable `sessionId -> mode to restore`. */
  persist?: PinStore | undefined
}

interface Active { unguard: () => void; restoreMode: string | undefined; pinnedMode: string | undefined; sessionId: string }

export class PinError extends Error {}

export class TurnPins {
  private readonly active = new Map<string, Active>()
  private pending: Record<string, string> = {}

  constructor(private readonly deps: PinDeps) {}

  async load(): Promise<void> { this.pending = (await this.deps.persist?.load()) ?? {} }

  has(agentId: string): boolean { return this.active.has(agentId) }

  /** Pin the agent for composio-originated turn(s). Idempotent: a second call only tightens. Throws PinError when it cannot be made safe. */
  apply(agent: PinnableAgent, sessionId: string, policy: PinPolicy): void {
    const now = this.deps.currentMode(agent)
    if (now === undefined) throw new PinError('The target session sandbox mode is unknown; refusing to deliver untrusted trigger text into it.')
    const existing = this.active.get(agent.id)
    if (existing === undefined) {
      let unguard = (): void => {}
      let done = false
      agent.ctx.effect(() => {
        const dispose = agent.ctx.tools.guard(this.deps.guard)
        unguard = () => { if (!done) { done = true; dispose() } }
        return unguard
      }, 'composio: existing-session turn guard')
      this.active.set(agent.id, { unguard, restoreMode: undefined, pinnedMode: undefined, sessionId })
      agent.ctx.effect(() => () => { this.active.delete(agent.id); this.deps.setRunPolicy(agent.id, undefined) }, 'composio: pin cleanup')
    }
    const entry = this.active.get(agent.id) as Active
    this.deps.setRunPolicy(agent.id, { allowTools: policy.allowTools, allowToolkits: policy.allowToolkits })
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

  /** The turn is over (a human spoke): drop the guard and policy, restore the session's previous sandbox mode. */
  lift(agent: PinnableAgent): void {
    const entry = this.active.get(agent.id)
    if (entry === undefined) return
    this.active.delete(agent.id)
    entry.unguard()
    this.deps.setRunPolicy(agent.id, undefined)
    // If the user changed the mode themselves while the pin was on, their choice wins.
    const now = this.deps.currentMode(agent)
    this.restore(agent, entry.sessionId, entry.pinnedMode === undefined || (now !== undefined && now !== entry.pinnedMode) ? undefined : entry.restoreMode)
    if (entry.restoreMode !== undefined && entry.pinnedMode !== undefined && now !== undefined && now !== entry.pinnedMode) { delete this.pending[entry.sessionId]; void this.deps.persist?.save(this.pending) }
  }

  /** `agent/inbox/claimed`: a human turn ends the pin. */
  onClaimed(agent: PinnableAgent, message: { source?: { kind?: string } }): void {
    if (message.source?.kind === 'user') this.lift(agent)
  }

  /** `agent/created`: a pin left behind by a previous process (or an unloaded agent) is undone. */
  onCreated(agent: PinnableAgent, sessionId: string): void {
    if (this.active.has(agent.id)) return
    const previous = this.pending[sessionId]
    if (previous !== undefined) this.restore(agent, sessionId, previous)
  }

  private restore(agent: PinnableAgent, sessionId: string, mode: string | undefined): void {
    if (mode === undefined) return
    try {
      agent.session.append('sandbox/mode', { mode })
    } catch (error) {
      this.deps.log.warn(`composio: could not restore the sandbox mode of ${sessionId}: ${String(error)}`)
      return
    }
    delete this.pending[sessionId]
    void this.deps.persist?.save(this.pending)
  }
}

/** Small JSON file under the composio data dir (0600, atomic). */
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
}

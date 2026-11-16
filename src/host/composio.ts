/**
 * Bridge to dsh-composio's `ctx.composio` service (optional). A Triggers automation with a Composio source owns a
 * Composio trigger instance:
 *  - save: with a connected account, the instance is created (upsert) when missing or when the slug/account changed;
 *    a Composio error fails the save before anything is stored;
 *  - the old instance is released when no other Triggers automation uses it (dsh-composio keeps it while one of its
 *    own routes still uses it);
 *  - enabled state: the instance is enabled while any Triggers automation on it is enabled (best effort).
 */
import type { Automation, ComposioSource } from '../shared/types.ts'
import { errorText } from './util.ts'
import { ValidationError } from './validate.ts'

export interface ComposioAccountRow { id?: string; wordId: string; alias: string | null; displayName?: string | null; status: string }
export interface ComposioToolkitRow { slug: string; name: string; accounts: ComposioAccountRow[] }
export interface ComposioTriggerType { slug: string; name: string; description: string; type?: string; instructions: string; config?: unknown }
export interface ComposioListenerState { state: string; lastEventAt?: number | null; lastError: string | null }

/** The part of dsh-composio's `ctx.composio` service Triggers uses. */
export interface ComposioServiceLike {
  connections(): Promise<ComposioToolkitRow[]>
  triggerTypes(toolkit: string): Promise<ComposioTriggerType[]>
  ensureTrigger(slug: string, connectedAccountId: string, config?: Record<string, unknown>): Promise<string>
  releaseTrigger(instanceId: string): Promise<void>
  setTriggerEnabled(instanceId: string, enabled: boolean): Promise<void>
  listenerState(): ComposioListenerState
}

export const WARN_NOT_INSTALLED = 'Composio plugin not installed; this automation will not receive events.'
export const WARN_NO_ACCOUNT = 'Pick a connected account so the trigger can be created in Composio.'

/** Response of the `composioAccounts` route. */
export interface ComposioAccountsView {
  available: boolean
  toolkits: { slug: string; name: string; accounts: { id: string; label: string; status: string }[] }[]
  listener: { state: string; lastError: string | null } | null
  error?: string
}
/** One row of the `composioTriggerTypes` route. */
export interface ComposioTriggerTypeView { slug: string; name: string; description: string; instructions: string }

const composioSource = (a: Automation | undefined): ComposioSource | undefined => (a?.source.kind === 'composio' ? a.source : undefined)
/**
 * The instance Triggers manages for this automation: only one created from a connected account. An instance id typed
 * in by hand (no account) belongs to someone else (a Composio-page route, the CLI) and is never toggled or deleted.
 */
export const managedInstance = (a: Automation | undefined): string | undefined => {
  const s = composioSource(a)
  return s?.connectedAccountId === undefined ? undefined : s.triggerInstanceId
}

export class ComposioBridge {
  constructor(
    private readonly service: () => ComposioServiceLike | undefined,
    private readonly automations: () => readonly Automation[],
    private readonly log: { warn(m: string): void },
  ) {}

  get available(): boolean { return this.service() !== undefined }

  /**
   * Before storing `next`: make sure it has its trigger instance. Mutates `next.source.triggerInstanceId`.
   * Returns warnings and the instance id created by this call (so a failed store can release it).
   */
  async prepare(next: Automation, prior: Automation | undefined): Promise<{ warnings: string[]; created?: string }> {
    const s = composioSource(next)
    if (s === undefined) return { warnings: [] }
    const p = composioSource(prior)
    const svc = this.service()
    const warnings: string[] = []
    if (svc === undefined) warnings.push(WARN_NOT_INSTALLED)
    const sameTrigger = p !== undefined && p.triggerSlug === s.triggerSlug && p.connectedAccountId === s.connectedAccountId
    if (s.connectedAccountId === undefined) {
      // Manual mode: an instance id typed in (or none: match every event of this slug).
      if (s.triggerInstanceId === undefined && sameTrigger && p.triggerInstanceId !== undefined) s.triggerInstanceId = p.triggerInstanceId
      if (s.triggerInstanceId === undefined) warnings.push(WARN_NO_ACCOUNT)
      return { warnings }
    }
    // With an account the instance is host-managed: keep the existing one, else create it.
    if (sameTrigger && p.triggerInstanceId !== undefined) { s.triggerInstanceId = p.triggerInstanceId; return { warnings } }
    delete s.triggerInstanceId
    if (svc === undefined) return { warnings }
    let id: string
    try { id = await svc.ensureTrigger(s.triggerSlug, s.connectedAccountId, {}) } catch (error) {
      throw new ValidationError(`Composio could not create the trigger: ${errorText(error).slice(0, 300)}`)
    }
    if (typeof id !== 'string' || id === '') throw new ValidationError('Composio did not return a trigger instance id')
    s.triggerInstanceId = id
    return { warnings, created: id }
  }

  /** After `next` was stored (prior = the previous version, if any). Returns warnings for best-effort failures. */
  async afterSave(next: Automation, prior: Automation | undefined): Promise<string[]> {
    const before = managedInstance(prior)
    const after = managedInstance(next)
    const warnings: string[] = []
    if (before !== undefined && before !== after) warnings.push(...await this.release(before))
    if (after !== undefined) await this.syncEnabled(after)
    return warnings
  }

  /** Release an instance no Triggers automation uses any more. Call only for managed instances. */
  async release(instanceId: string): Promise<string[]> {
    if (this.inUse(instanceId)) return []
    const svc = this.service()
    if (svc === undefined) return []
    try { await svc.releaseTrigger(instanceId); return [] } catch (error) {
      this.log.warn(`triggers: could not release Composio trigger ${instanceId.slice(0, 16)}: ${errorText(error).slice(0, 200)}`)
      return [`Could not remove the old Composio trigger ${instanceId}: ${errorText(error).slice(0, 200)}`]
    }
  }

  /** Enable the instance while any Triggers automation on it is enabled (best effort). */
  async syncEnabled(instanceId: string): Promise<void> {
    const svc = this.service()
    if (svc === undefined) return
    const enabled = this.automations().some((a) => a.enabled && composioSource(a)?.triggerInstanceId === instanceId)
    if (!enabled && !this.automations().some((a) => managedInstance(a) === instanceId)) return // not ours
    try { await svc.setTriggerEnabled(instanceId, enabled) } catch (error) {
      this.log.warn(`triggers: could not ${enabled ? 'enable' : 'disable'} Composio trigger ${instanceId.slice(0, 16)}: ${errorText(error).slice(0, 200)}`)
    }
  }

  inUse(instanceId: string): boolean { return this.automations().some((a) => composioSource(a)?.triggerInstanceId === instanceId) }

  async accounts(): Promise<ComposioAccountsView> {
    const svc = this.service()
    if (svc === undefined) return { available: false, toolkits: [], listener: null }
    let listener: ComposioAccountsView['listener'] = null
    try { const l = svc.listenerState(); listener = { state: String(l.state), lastError: l.lastError ?? null } } catch { /* unknown */ }
    try {
      const rows = await svc.connections()
      const toolkits = rows.map((t) => ({
        slug: t.slug, name: t.name || t.slug,
        accounts: t.accounts.flatMap((a, i) => {
          const id = a.id ?? ''
          if (id === '') return []
          const alias = a.alias?.trim() ?? ''; const display = a.displayName?.trim() ?? ''
          const label = alias !== '' ? alias : display !== '' ? display : `Account ${String(i + 1)}`
          return [{ id, label, status: a.status }]
        }),
      }))
      return { available: true, toolkits, listener }
    } catch (error) {
      return { available: true, toolkits: [], listener, error: errorText(error).slice(0, 300) }
    }
  }

  async triggerTypes(toolkit: string): Promise<ComposioTriggerTypeView[]> {
    const svc = this.service()
    if (svc === undefined) throw new ValidationError(WARN_NOT_INSTALLED)
    if (!/^[a-z0-9_-]{1,64}$/i.test(toolkit)) throw new ValidationError('toolkit must be a toolkit slug, e.g. gmail')
    const rows = await svc.triggerTypes(toolkit.toLowerCase())
    return rows.map((t) => ({ slug: t.slug, name: t.name, description: t.description, instructions: t.instructions }))
  }
}

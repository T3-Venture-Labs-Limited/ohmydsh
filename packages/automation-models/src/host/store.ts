/**
 * Durable state in our own storage-domain (`ctx.storageDomain`): per-source defaults, per-item overrides, crash-restore
 * markers and the global kill switch. Reads are synchronous from memory once opened; until then the store reports
 * "disabled" so the hook fails open (the session keeps its own model).
 *
 * Record schemas are tiny hand-written validators (`parse` only) instead of zod: the domain facility only calls
 * `valueSchema.parse`, and this keeps zod out of the bundle.
 */
import type { DefaultRecord, MarkerRecord, OverrideRecord, Route, StoreFace } from './core.ts'

export interface OverrideRow extends OverrideRecord { kind: string; key: string }
export interface DefaultRow extends DefaultRecord { kind: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseRoute(value: unknown): Route {
  if (!isRecord(value) || typeof value['provider'] !== 'string' || value['provider'] === '' || typeof value['model'] !== 'string' || value['model'] === '') throw new Error('route needs provider and model')
  const effort = value['reasoningEffort']
  if (effort !== undefined && (typeof effort !== 'string' || effort === '')) throw new Error('reasoningEffort must be a non-empty string')
  return { provider: value['provider'], model: value['model'], ...(effort === undefined ? {} : { reasoningEffort: effort as string }) }
}
const parseNullableRoute = (value: unknown): Route | null => (value === null ? null : parseRoute(value))

const schema = <T>(parse: (value: unknown) => T) => ({ parse, safeParse: (value: unknown) => { try { return { success: true as const, data: parse(value) } } catch (error) { return { success: false as const, error } } } })

const overrideSchema = schema((value): OverrideRow => {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || typeof value['key'] !== 'string') throw new Error('bad override')
  return { kind: value['kind'], key: value['key'], route: parseNullableRoute(value['route']), ...(value['keep'] === true ? { keep: true } : {}) }
})
const defaultSchema = schema((value): DefaultRow => {
  if (!isRecord(value) || typeof value['kind'] !== 'string') throw new Error('bad default')
  return { kind: value['kind'], route: parseNullableRoute(value['route']) }
})
const markerSchema = schema((value): MarkerRecord => {
  if (!isRecord(value) || typeof value['at'] !== 'number') throw new Error('bad marker')
  return { previous: parseRoute(value['previous']), applied: parseRoute(value['applied']), at: value['at'] }
})
const globalSchema = schema((value): { enabled: boolean } => {
  if (!isRecord(value) || typeof value['enabled'] !== 'boolean') throw new Error('bad global')
  return { enabled: value['enabled'] }
})

/** Plain DomainSpec literal (same shape `defineDomain` returns), built by hand so no runtime import is needed. */
export const automationDomain = {
  name: 'automation_models',
  version: 1,
  global: { schema: globalSchema, initial: { enabled: true } },
  tables: {
    overrides: { valueSchema: overrideSchema },
    defaults: { valueSchema: defaultSchema },
    markers: { valueSchema: markerSchema },
  },
}

interface Table<V> { get(key: string): V | undefined; entries(): IterableIterator<[string, V]>; put(key: string, value: V): Promise<void>; delete(key: string): Promise<boolean>; deleteMany(keys: readonly string[]): Promise<number> }
export interface DomainFace {
  table(name: string): Table<unknown>
  global: { get(): unknown; set(value: unknown): Promise<void> }
  close(): Promise<void>
}

export const overrideKey = (kind: string, key: string): string => `${kind}\u0000${key}`

export class AutomationStore implements StoreFace {
  private domain: DomainFace | undefined

  attach(domain: DomainFace): void { this.domain = domain }
  detach(): void { this.domain = undefined }
  get ready(): boolean { return this.domain !== undefined }

  private table<V>(name: string): Table<V> | undefined { return this.domain?.table(name) as Table<V> | undefined }

  enabled(): boolean { return this.domain !== undefined && (this.domain.global.get() as { enabled: boolean }).enabled }
  async setEnabled(enabled: boolean): Promise<void> { await this.domain?.global.set({ enabled }) }

  getDefault(kind: string): DefaultRecord | undefined { return this.table<DefaultRow>('defaults')?.get(kind) }
  async setDefault(kind: string, route: Route | null | undefined): Promise<void> {
    const table = this.table<DefaultRow>('defaults')
    if (route === undefined) await table?.delete(kind)
    else await table?.put(kind, { kind, route })
  }
  listDefaults(): DefaultRow[] { return [...(this.table<DefaultRow>('defaults')?.entries() ?? [])].map(([, row]) => row) }

  getOverride(kind: string, key: string): OverrideRecord | undefined { return this.table<OverrideRow>('overrides')?.get(overrideKey(kind, key)) }
  async setOverride(kind: string, key: string, record: OverrideRecord | undefined): Promise<void> {
    const table = this.table<OverrideRow>('overrides')
    if (record === undefined) await table?.delete(overrideKey(kind, key))
    else await table?.put(overrideKey(kind, key), { kind, key, ...record })
  }
  listOverrides(): OverrideRow[] { return [...(this.table<OverrideRow>('overrides')?.entries() ?? [])].map(([, row]) => row) }
  /** Drop overrides of `kind` whose key is not in `liveKeys` (a deleted schedule task). */
  async pruneOverrides(kind: string, liveKeys: ReadonlySet<string>): Promise<number> {
    const table = this.table<OverrideRow>('overrides')
    if (table === undefined) return 0
    const stale = [...table.entries()].filter(([, row]) => row.kind === kind && !liveKeys.has(row.key)).map(([key]) => key)
    return stale.length === 0 ? 0 : table.deleteMany(stale)
  }

  getMarker(agentId: string): MarkerRecord | undefined { return this.table<MarkerRecord>('markers')?.get(agentId) }
  putMarker(agentId: string, marker: MarkerRecord): void { void this.table<MarkerRecord>('markers')?.put(agentId, marker).catch(() => {}) }
  deleteMarker(agentId: string): void { void this.table<MarkerRecord>('markers')?.delete(agentId).catch(() => {}) }
}

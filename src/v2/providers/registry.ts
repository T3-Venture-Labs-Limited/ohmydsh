/** Provider registry + hybrid catalog: curated presets (authoritative for params) merged with discovered models. */
import { AdapterError, capabilitiesFor, mediaKindOf, supports, type Capability, type MediaKind, type ModelDescriptor, type OperationRequest, type ProviderAdapter, type ProviderId } from '../contracts.js'

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>()

  register(adapter: ProviderAdapter): () => void {
    this.adapters.set(adapter.id, adapter)
    return () => { if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id) }
  }

  get(id: ProviderId): ProviderAdapter | undefined { return this.adapters.get(id) }
  providers(): ProviderAdapter[] { return [...this.adapters.values()] }

  async configuredProviders(): Promise<ProviderId[]> {
    const out: ProviderId[] = []
    for (const adapter of this.adapters.values()) if (await adapter.isConfigured().catch(() => false)) out.push(adapter.id)
    return out
  }

  /** All known models, optionally filtered. Discovery failures never hide the curated list. */
  async listModels(filter: { capability?: Capability; provider?: ProviderId; configuredOnly?: boolean; refresh?: boolean } = {}): Promise<ModelDescriptor[]> {
    const out: ModelDescriptor[] = []
    for (const adapter of this.adapters.values()) {
      if (filter.provider !== undefined && adapter.id !== filter.provider) continue
      if (filter.configuredOnly === true && !(await adapter.isConfigured().catch(() => false))) continue
      const models = await adapter.listModels(filter.refresh === undefined ? {} : { refresh: filter.refresh }).catch(() => [] as readonly ModelDescriptor[])
      for (const model of models) if (filter.capability === undefined || model.capabilities.includes(filter.capability)) out.push(model)
    }
    return out
  }

  async resolveModel(modelId: string): Promise<{ adapter: ProviderAdapter; model: ModelDescriptor }> {
    const provider = modelId.slice(0, modelId.indexOf(':')) as ProviderId
    const adapter = this.adapters.get(provider)
    if (adapter === undefined) throw new AdapterError('unsupported', `No provider adapter for "${provider}"`)
    const models = await adapter.listModels()
    const model = models.find(m => m.id === modelId)
    if (model === undefined) throw new AdapterError('unsupported', `Unknown model "${modelId}". Call studio_models to list available models.`)
    return { adapter, model }
  }

  /**
   * Pick the default model for a request: the first configured curated model that has the needed capabilities.
   * `only` restricts the choice to one provider; `prefer` (a provider id, usually the user's configured default) is tried first
   * and only loses to nothing: when it has no suitable model the next best provider is used.
   */
  async pickDefault(request: Pick<OperationRequest, 'op' | 'inputs'>, kind: MediaKind, preferred: readonly string[] = [], options: { only?: ProviderId; prefer?: ProviderId } = {}): Promise<ModelDescriptor | undefined> {
    const needed = capabilitiesFor(request, kind)
    const configured = new Set(await this.configuredProviders())
    const all = (await this.listModels({ configuredOnly: true })).filter(m => configured.has(m.provider) && supports(m, needed) && mediaKindOf(m.capabilities) === kind && m.deprecated !== true && (options.only === undefined || m.provider === options.only))
    for (const id of preferred) { const hit = all.find(m => m.id === id); if (hit !== undefined) return hit }
    const pool = options.prefer !== undefined && all.some(m => m.provider === options.prefer) ? all.filter(m => m.provider === options.prefer) : all
    return pool.find(m => m.curated && m.tier === 'quality') ?? pool.find(m => m.curated) ?? pool[0]
  }
}

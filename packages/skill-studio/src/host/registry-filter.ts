// Instance patch of the live SkillRegistry read methods (list / snapshot / get) that hides DSH-disabled skills from every
// consumer at once: the model catalog, the `skill` tool, `/name` injection and the client `/` menu. Fails open: any
// unexpected registry shape, version or runtime result leaves DSH untouched and logs once.
import { AsyncLocalStorage } from 'node:async_hooks'

export interface Logger { info(message: string): void; warn(message: string): void }

export interface RegistryFilterDeps {
  /** True when `name` is disabled for this workspace. May be async (project-root lookup). */
  isDisabled(name: string, cwd: string | undefined): Promise<boolean> | boolean
  logger: Logger
}

export interface SkillSummaryLike { name: string; [key: string]: unknown }
export interface RawRegistry {
  snapshot(options?: unknown): Promise<{ skills: SkillSummaryLike[]; complete: boolean }>
  list(options?: unknown): Promise<SkillSummaryLike[]>
  get(name: string, options?: unknown): Promise<{ name: string; content: string; [key: string]: unknown } | undefined>
}

export interface FilterHandle {
  installed: boolean
  reason?: string
  /** Unfiltered methods, bound to the registry. Only valid while installed; undefined when the shape was rejected. */
  raw?: RawRegistry
  /** The scope key of the most recent live consumer lookup (agent), to read preset-layer skills unfiltered. */
  lastScope(): object | undefined
  dispose(): void
}

const MARK = Symbol.for('dsh-skill-studio.registry-patched')
const METHODS = ['list', 'snapshot', 'get'] as const

function hasShape(reg: unknown): reg is Record<string, unknown> {
  if (typeof reg !== 'object' || reg === null) return false
  const r = reg as Record<string, unknown>
  return METHODS.every(m => typeof r[m] === 'function')
}

export function installRegistryFilter(reg: unknown, deps: RegistryFilterDeps): FilterHandle {
  const { logger } = deps
  const none = (reason: string): FilterHandle => {
    logger.warn(`skill-studio: not filtering skills (${reason}); DSH skills are left untouched (fail open)`)
    return { installed: false, reason, lastScope: () => undefined, dispose: () => {} }
  }
  if (!hasShape(reg)) return none('SkillRegistry shape changed: list/snapshot/get missing')
  const target = reg as Record<string | symbol, unknown>
  if (target[MARK] === true) return none('registry is already patched by another instance of this plugin')
  for (const m of METHODS) {
    const d = Object.getOwnPropertyDescriptor(target, m) ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target) as object, m)
    if (d !== undefined && d.writable === false && d.set === undefined && d.configurable === false) return none(`SkillRegistry.${m} is not writable`)
  }
  if (Object.isFrozen(target)) return none('SkillRegistry instance is frozen')

  const origOwn = Object.fromEntries(METHODS.map(m => [m, Object.getOwnPropertyDescriptor(target, m)]))
  const fn = Object.fromEntries(METHODS.map(m => [m, target[m] as (...args: unknown[]) => Promise<unknown>])) as Record<(typeof METHODS)[number], (...args: unknown[]) => Promise<unknown>>
  // The real SkillRegistry.list() calls this.snapshot() internally, so a plain "original" call would still hit the
  // patched snapshot. Calls made through `raw` run inside this async context and every patched method passes through.
  const bypass = new AsyncLocalStorage<true>()
  const unfiltered = <T>(run: () => Promise<T>): Promise<T> => bypass.run(true, run)
  const raw: RawRegistry = {
    snapshot: (o) => unfiltered(() => fn.snapshot.call(target, o) as ReturnType<RawRegistry['snapshot']>),
    list: (o) => unfiltered(() => fn.list.call(target, o) as ReturnType<RawRegistry['list']>),
    get: (n, o) => unfiltered(() => fn.get.call(target, n, o) as ReturnType<RawRegistry['get']>),
  }
  let scope: WeakRef<object> | undefined
  let shapeWarned = false
  const shapeWarn = (what: string): void => {
    if (shapeWarned) return
    shapeWarned = true
    logger.warn(`skill-studio: SkillRegistry returned an unexpected ${what}; passing it through unfiltered (fail open)`)
  }
  const remember = (options: unknown): { cwd: string | undefined } => {
    const o = (typeof options === 'object' && options !== null ? options : {}) as { cwd?: unknown; scope?: unknown }
    if (typeof o.scope === 'object' && o.scope !== null) scope = new WeakRef(o.scope)
    return { cwd: typeof o.cwd === 'string' ? o.cwd : undefined }
  }
  const keep = async (skills: SkillSummaryLike[], cwd: string | undefined): Promise<SkillSummaryLike[]> => {
    const out: SkillSummaryLike[] = []
    for (const skill of skills) {
      let hidden = false
      try { hidden = await deps.isDisabled(skill.name, cwd) } catch (error) { shapeWarn(`filter error: ${String(error)}`) }
      if (!hidden) out.push(skill)
    }
    return out
  }
  const patched = {
    async snapshot(this: unknown, options?: unknown) {
      const result = await fn.snapshot.call(target, options) as { skills?: unknown; complete?: unknown }
      if (bypass.getStore() === true) return result
      const { cwd } = remember(options)
      if (!Array.isArray(result?.skills)) { shapeWarn('snapshot result'); return result }
      return { ...result, skills: await keep(result.skills as SkillSummaryLike[], cwd) }
    },
    async list(this: unknown, options?: unknown) {
      const result = await fn.list.call(target, options)
      if (bypass.getStore() === true) return result
      const { cwd } = remember(options)
      if (!Array.isArray(result)) { shapeWarn('list result'); return result }
      return keep(result as SkillSummaryLike[], cwd)
    },
    async get(this: unknown, name: string, options?: unknown) {
      if (bypass.getStore() === true) return fn.get.call(target, name, options)
      const { cwd } = remember(options)
      let hidden = false
      try { hidden = typeof name === 'string' && await deps.isDisabled(name, cwd) } catch (error) { shapeWarn(`filter error: ${String(error)}`) }
      if (hidden) return undefined
      return fn.get.call(target, name, options)
    },
  }
  for (const m of METHODS) Object.defineProperty(target, m, { configurable: true, writable: true, enumerable: false, value: patched[m] })
  Object.defineProperty(target, MARK, { configurable: true, enumerable: false, writable: true, value: true })
  logger.info('skill-studio: skill registry filter installed')
  return {
    installed: true,
    raw,
    lastScope: () => scope?.deref(),
    dispose() {
      for (const m of METHODS) {
        const d = origOwn[m]
        if (d === undefined) delete target[m]
        else Object.defineProperty(target, m, d)
      }
      delete target[MARK]
    },
  }
}

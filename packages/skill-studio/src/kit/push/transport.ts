// Transport half of the push channel (imported by a plugin's boot entry only). DSH's Typert gateway multiplexes every stream
// of a page over ONE WebSocket (/api/remote.mux). A WebSocket does not count against the browser's 6-connections-per-host
// HTTP/1.1 pool, which EventSource streams do, one each, for their whole life. `createPushTransport` gives a plugin that
// transport without a code generator. The stream lifecycle (visibility, sharing, fallback poll) is in ./client.ts, which a
// plugin's lazy views import; the two files share no code, so the build never has to extract a shared chunk.

/** One logical stream handle as `ctx.remote.<namespace>.<method>(...)` returns it. */
interface StreamHandle<T> extends AsyncIterable<T> { dispose(): void }

/** The slice of the gateway's client `ctx.remote` used here. */
export interface PushRemote {
  $mount(contribution: PushContribution): Promise<() => Promise<void>>
  [namespace: string]: unknown
}
export interface PushContribution { readonly package: string; readonly descriptors: readonly unknown[] }

export interface PushStreamSpec {
  /** Wire method name. */
  readonly method: string
  /** Wire field names in call order (the host method's parameters without the trailing `signal`). */
  readonly params?: readonly string[]
}

export interface PushRemoteSpec {
  /** npm package that owns the host service; unique per plugin. */
  readonly pkg: string
  /** Cordis service key of the host service. */
  readonly serviceKey: string
  /** Wire namespace of the host service. */
  readonly namespace: string
  readonly streams: readonly PushStreamSpec[]
}

// Hand-written strict codec for a JSON string/number parameter: the client gateway insists on strict parameter codecs,
// and the host (source mode) validates the value as JSON itself.
const passthrough = { mode: 'strict', typeSymbol: 'json', create: () => ({ parse: (value: unknown): unknown => value }) } as const

/** Build the descriptors the client gateway needs to call the plugin's host streams. */
export function pushContribution(spec: PushRemoteSpec): PushContribution {
  return {
    package: spec.pkg,
    descriptors: spec.streams.map((stream) => ({
      id: `${spec.pkg}#${spec.namespace}/${stream.method}`,
      service: spec.serviceKey,
      namespace: spec.namespace,
      method: stream.method,
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: (stream.params ?? []).map((name) => ({ name, wire: name, source: 'json', acceptsUndefined: true, codec: passthrough })),
      result: { mode: 'src-json' },
    })),
  }
}

export interface MountedPush {
  /** Resolves once the contribution is mounted (streams may be opened), rejects if mounting failed. */
  readonly ready: Promise<void>
  dispose(): void
}

/** Mount the plugin's stream methods on `ctx.remote`; call `dispose()` (or hand it to `ctx.effect`) to withdraw them. */
export function mountPushRemote(remote: PushRemote | undefined, spec: PushRemoteSpec): MountedPush {
  if (remote === undefined || typeof remote.$mount !== 'function') {
    const ready = Promise.reject(new Error('push: ctx.remote is unavailable'))
    ready.catch(() => undefined) // consumers handle the rejection; never leave it unhandled
    return { ready, dispose() {} }
  }
  const mounted = remote.$mount(pushContribution(spec))
  const ready = mounted.then(() => undefined)
  ready.catch(() => undefined) // consumers handle the rejection; never leave it unhandled
  return { ready, dispose() { void mounted.then((off) => off()).catch(() => undefined) } }
}

/** Open one logical stream on the page's shared socket; aborting `signal` cancels it on the wire. */
export async function* muxStream<T>(
  remote: PushRemote, mounted: MountedPush, namespace: string, method: string, args: readonly unknown[], signal: AbortSignal,
): AsyncGenerator<T, void, void> {
  await mounted.ready
  signal.throwIfAborted()
  const space = remote[namespace] as Record<string, (...values: unknown[]) => StreamHandle<T>> | undefined
  const open = space?.[method]
  if (typeof open !== 'function') throw new Error(`push: ${namespace}/${method} is not mounted`)
  const handle = open.apply(space, args as unknown[])
  const stop = (): void => { handle.dispose() }
  signal.addEventListener('abort', stop, { once: true })
  try { yield* handle } finally { signal.removeEventListener('abort', stop); handle.dispose() }
}

/** The slice of a client Cordis context the transport needs. */
export interface PushScope { remote?: unknown; inject(deps: string[], callback: (scope: PushScope) => void | (() => void)): unknown }
export interface PushCtx { inject: PushScope['inject'] }

const GATEWAY_WAIT_MS = 10_000

export interface PushTransport {
  /** Open `<namespace>/<method>` on the page's shared socket; waits for the gateway, ends when `signal` aborts. */
  stream<T>(method: string, args: readonly unknown[], signal: AbortSignal): AsyncGenerator<T, void, void>
}

/**
 * Mount a plugin's push streams as soon as the gateway's `remote` service exists, and withdraw them when the plugin
 * unloads. The returned transport is usable (and cancellable) before the gateway is up.
 */
export function createPushTransport(ctx: PushCtx, spec: PushRemoteSpec): PushTransport {
  let current: { remote: PushRemote; mounted: MountedPush } | undefined
  const waiters = new Set<() => void>()
  ctx.inject(['remote'], (scope) => {
    const mounted = mountPushRemote(scope.remote as PushRemote, spec)
    // The gateway installs `remote.<namespace>` as its own Cordis service once the contribution is mounted; reading
    // `remote.<namespace>` is only legal inside a scope that injected it.
    const offNamespace = scope.inject([`remote.${spec.namespace}`], (inner) => {
      current = { remote: inner.remote as PushRemote, mounted }
      for (const wake of waiters) wake()
      return () => { if (current?.mounted === mounted) current = undefined }
    })
    return () => { if (typeof offNamespace === 'function') offNamespace(); if (current?.mounted === mounted) current = undefined; mounted.dispose() }
  })
  const available = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (current !== undefined) { resolve(); return }
    // No gateway after a while (older DSH, disabled): fail the open so the consumer falls back to its slow poll.
    const timer = setTimeout(() => { settle(); reject(new Error('push: the Remote gateway is not available')) }, GATEWAY_WAIT_MS)
    const settle = (): void => { clearTimeout(timer); waiters.delete(wake); signal.removeEventListener('abort', abort) }
    const wake = (): void => { settle(); resolve() }
    const abort = (): void => { settle(); reject(signal.reason) }
    waiters.add(wake)
    signal.addEventListener('abort', abort, { once: true })
  })
  return {
    async *stream<T>(method: string, args: readonly unknown[], signal: AbortSignal) {
      await available(signal)
      const { remote, mounted } = current as NonNullable<typeof current>
      yield* muxStream<T>(remote, mounted, spec.namespace, method, args, signal)
    },
  }
}

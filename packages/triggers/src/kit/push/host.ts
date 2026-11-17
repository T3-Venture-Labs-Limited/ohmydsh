// Host half of the push channel: expose async-iterable streams through DSH's Typert gateway (one WebSocket per page,
// /api/remote.mux) instead of a per-plugin HTTP/SSE route. Browsers allow 6 HTTP/1.1 connections per host and every
// EventSource holds one for its whole life; a mux stream costs none.
//
// Third-party plugins have no code generator, so this registers a hand-built Cordis service the gateway discovers
// ("SRC mode"): a visible `typertRemote` binding plus the versioned marker the `@Remote` decorator would write. It needs
// no runtime import of @deepseek-ai/dsh-typert-protocol. The gateway reads each method's parameter names off its source
// (`methodParameterNames`), so implementations must be plain functions with plain identifier parameters, the wire
// fields in order and an optional trailing `signal`.

/** The marker key the gateway reads off a service prototype (see @deepseek-ai/dsh-typert-protocol). */
export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export interface PushStream {
  /** Wire method name. */
  readonly method: string
  /** Plain function `(…wireFields, signal) => AsyncIterable`. */
  readonly implementation: (...args: never[]) => AsyncIterable<unknown>
}

export interface PushHostCtx {
  readonly reflect: { provide(name: string, value: unknown): () => void }
}

export interface RegisterPushOptions {
  readonly ctx: PushHostCtx
  /** Cordis service key; unique in the composition. */
  readonly serviceKey: string
  /** Wire namespace; an endpoint is `<namespace>/<method>`. */
  readonly namespace: string
  readonly streams: readonly PushStream[]
}

/**
 * Register the service the gateway routes `<namespace>/<method>` stream calls to.
 * @returns the disposer that unregisters it (hand it to `ctx.effect`).
 */
export function registerPushRemote({ ctx, serviceKey, namespace, streams }: RegisterPushOptions): () => void {
  // A context without Cordis `reflect` (a stripped-down embedding or a test double) has no gateway to serve: do nothing.
  if ((ctx as Partial<PushHostCtx>).reflect === undefined) return () => {}
  const service: Record<string, unknown> = {}
  Object.defineProperty(service, 'ctx', { value: ctx, enumerable: false, writable: true })
  Object.defineProperty(service, 'name', { value: serviceKey, enumerable: false, writable: true })
  Object.defineProperty(service, 'typertRemote', { value: Object.freeze({ service, serviceKey, namespace }), enumerable: false })
  const prototype: Record<string, unknown> = {}
  for (const { method, implementation } of streams) {
    Object.defineProperty(prototype, method, { value: implementation, enumerable: false, writable: false })
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(streams.map(({ method }) => Object.freeze({ method, mode: 'stream', invocation: Object.freeze({ kind: 'direct' }) }))),
    }),
    enumerable: false,
  })
  Object.setPrototypeOf(service, prototype)
  return ctx.reflect.provide(serviceKey, service)
}

/** Most frames a slow page may fall behind before its stream is ended (the page then reconnects and re-reads a snapshot). */
export const MAX_QUEUED = 5_000

/**
 * Turn a subscription into an AsyncIterable that ends cleanly when `signal` aborts and tears the subscription down.
 * `initial` is yielded first, so a (re)connecting page always starts from a snapshot and misses nothing between
 * snapshot and subscription (the subscription is attached before `initial` runs).
 * @param subscribe - attaches a listener, returns its disposer.
 * @param signal - the stream's cancellation.
 * @param initial - called once after subscribing; its return values are yielded first.
 */
export async function* pushIterable<T>(
  subscribe: (emit: (value: T) => void) => () => void,
  signal: AbortSignal | undefined,
  initial?: () => readonly T[],
): AsyncGenerator<T, void, void> {
  const queue: T[] = []
  let wake: (() => void) | undefined
  let overflow = false
  const poke = (): void => { const w = wake; wake = undefined; w?.() }
  const off = subscribe((value) => {
    if (queue.length >= MAX_QUEUED) { overflow = true; poke(); return }
    queue.push(value); poke()
  })
  const onAbort = (): void => { poke() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // Subscribing and reading the snapshot happen in one synchronous step, so nothing can slip in between them.
    if (initial !== undefined) queue.unshift(...initial())
    while (signal?.aborted !== true) {
      if (overflow) throw new Error('push stream consumer fell behind')
      if (queue.length > 0) { yield queue.shift() as T; continue }
      await new Promise<void>((resolve) => { wake = resolve; if (queue.length > 0 || overflow || signal?.aborted === true) poke() })
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    off()
  }
}

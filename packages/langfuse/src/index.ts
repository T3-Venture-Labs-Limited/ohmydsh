/**
 * Host half: Langfuse tracing for DSH. One trace per turn, Langfuse session = root DSH session id.
 * Feeds from the durable `session/event` log, the global `llm/stream` waterfall (observe-only tap),
 * and `subagent/start|end`. Owns a private OTel provider; never installs a global one.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { Config, resolveConfig, type Resolved } from './host/config.ts'
import { registerRemoteService } from './host/remote.ts'
import { createRuntime, type Runtime } from './host/runtime.ts'
import { Tracer, traceIdFor, type LlmOptionsView, type SessionEventView, type SessionView } from './host/tracer.ts'

export const name = 'langfuse'
export { Config }
export const inject = ['llm', 'sessions']

const NAMESPACE = 'langfuse'

interface TraceLink { ok: boolean; url?: string; traceId?: string; reason?: string }

const asView = (session: Session): SessionView => ({ id: session.id, header: session.header as unknown as SessionView['header'] })

/** Resolve the project that actually receives the traces from the key pair (never hard-coded). */
async function fetchProjectId(config: Resolved, signal: AbortSignal): Promise<string | undefined> {
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')
  const response = await fetch(`${config.baseUrl}/api/public/projects`, { headers: { authorization: `Basic ${auth}` }, signal })
  if (!response.ok) return undefined
  const body = (await response.json()) as { data?: { id?: string }[] }
  const id = body.data?.[0]?.id
  return typeof id === 'string' ? id : undefined
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('langfuse')
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() }, 'langfuse: lifetime')

  let tracer: Tracer | undefined
  let runtime: Runtime | undefined
  let disabledReason: string | undefined = 'starting'
  let projectId: string | undefined
  let projectResolved = false
  const startedAt = Date.now()

  const readCredential = async (key: string): Promise<string | undefined> => {
    try {
      const credentials = ctx.get('credentials') as { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined
      return (await credentials?.resolve(key))?.value
    } catch { return undefined }
  }

  const link = async (sessionId: string, messageId: string): Promise<TraceLink> => {
    if (tracer === undefined) return { ok: false, reason: disabledReason ?? 'tracing is off' }
    const cfg = tracer.config
    if (!cfg.openTraceButton) return { ok: false, reason: 'Open trace is disabled in config' }
    let traceId = tracer.traceIdOfMessage(messageId)
    if (traceId === undefined) {
      // After a restart the in-memory index is empty: recompute the deterministic id from the durable log.
      const session = ctx.sessions.get(sessionId as never) as Session | undefined
      if (session !== undefined && session.header.origin !== 'subagent') {
        let turnStart: number | undefined
        // oxlint-disable-next-line typescript/no-deprecated -- read-only scan of the canonical log
        for (const event of session.snapshotEvents()) {
          if (event.type === 'turn/start') turnStart = event.seq
          if (event.type === 'assistant/message' && (event.data as { message: { id: string } }).message.id === messageId) {
            traceId = turnStart === undefined ? undefined : traceIdFor(session.id, turnStart)
            break
          }
        }
      }
    }
    if (traceId === undefined) return { ok: false, reason: 'no trace recorded for this message (not sampled or older than the plugin)' }
    if (!projectResolved) {
      projectResolved = true
      try { projectId = await fetchProjectId(cfg, AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)])) } catch { projectResolved = false }
    }
    const url = projectId === undefined ? `${cfg.baseUrl}/trace/${traceId}` : `${cfg.baseUrl}/project/${projectId}/traces/${traceId}`
    return { ok: true, url, traceId }
  }

  // Remote endpoints: parameter names are the wire field names (the Gateway matches them exactly).
  const traceFor = async function traceFor(this: unknown, sessionId: unknown, messageId: unknown): Promise<TraceLink> {
    if (typeof sessionId !== 'string' || typeof messageId !== 'string') return { ok: false, reason: 'invalid arguments' }
    return link(sessionId, messageId)
  }
  const status = function status(this: unknown): { enabled: boolean; reason?: string; baseUrl?: string; environment?: string } {
    return tracer === undefined ? { enabled: false, ...(disabledReason === undefined ? {} : { reason: disabledReason }) } : { enabled: true, baseUrl: tracer.config.baseUrl, environment: tracer.config.environment }
  }
  ctx.effect(() => registerRemoteService(ctx, 'langfuseRemote', NAMESPACE, [
    { method: 'traceFor', implementation: traceFor },
    { method: 'status', implementation: status },
  ]), 'langfuse: remote endpoints')

  void (async () => {
    const result = await resolveConfig(config, process.env, readCredential)
    if (lifetime.signal.aborted) return
    if ('disabled' in result) {
      disabledReason = result.disabled
      logger.info(`tracing off: ${result.disabled}`)
      return
    }
    const resolved = result.resolved
    runtime = createRuntime(resolved)
    const rt = runtime
    const t = new Tracer({
      config: resolved,
      pin: rt.pin,
      lookup: (id) => { const s = ctx.sessions.get(id as never) as Session | undefined; return s === undefined ? undefined : asView(s) },
      onTurnEnd: () => { void rt.forceFlush(resolved.flushTimeoutMs) },
      log: (m) => { logger.debug(m) },
    })
    tracer = t
    disabledReason = undefined
    logger.info(`tracing to ${resolved.baseUrl} (environment ${resolved.environment})`)

    // Durable feed. Events from before the plugin started are ignored (no partial/duplicate traces after a hot reload).
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.time < startedAt - 1000) return
      t.onEvent(asView(session), event as unknown as SessionEventView)
    })
    ctx.on('session/disposed', (session: Session) => { t.disposeSession(session.id) })

    // dsh-subagent's event declarations are not a dependency of this plugin; bind through a structural face.
    const bus = ctx as unknown as { on(name: string, listener: (info: never) => void): () => void }
    bus.on('subagent/start', (info) => { t.onSubagentStart(info) })
    bus.on('subagent/end', (info) => { t.onSubagentEnd(info) })

    // Observe-only tap on every model call (loop steps, titles, compaction). Never alters or throws into the stream.
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
      let recorder: ReturnType<Tracer['startGeneration']>
      try { recorder = t.startGeneration(options as unknown as LlmOptionsView) } catch (error) { logger.debug(`generation start failed: ${String(error)}`) }
      const upstream = next()
      if (recorder === undefined) return upstream
      const rec = recorder
      return (async function* tap(): AsyncGenerator<StreamChunk> {
        try {
          for await (const chunk of upstream) {
            try { rec.chunk(chunk as never) } catch { /* observer must never break the stream */ }
            yield chunk
          }
        } catch (error) {
          try { rec.fail(error) } catch { /* ignore */ }
          throw error
        } finally {
          try { rec.close() } catch { /* ignore */ }
        }
      })()
    }, { global: true })

    ctx.on('session/flush', () => { void rt.forceFlush(resolved.flushTimeoutMs) })

    ctx.effect(() => async () => {
      t.shutdown()
      await rt.shutdown(resolved.flushTimeoutMs)
    }, 'langfuse: flush and shutdown')
  })().catch((error: unknown) => {
    disabledReason = `startup failed: ${String(error)}`
    logger.warn(disabledReason)
  })
}

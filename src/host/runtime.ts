// Isolated OTel runtime: a private NodeTracerProvider + LangfuseSpanProcessor. Never installs a global provider.
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { setLangfuseTracerProvider } from '@langfuse/tracing'
import { AlwaysOnSampler, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { Resolved } from './config.ts'
import { environmentSecrets, redactString, sanitize } from './redact.ts'
import type { TraceIdPin } from './tracer.ts'

function hex(bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return out
}

/** Random ids, except the next ROOT trace id may be pinned so it is deterministic per (session, turn). */
class PinnedIdGenerator {
  constructor(private readonly pin: TraceIdPin) {}
  generateTraceId(): string {
    const pinned = this.pin.next
    if (pinned !== undefined) { this.pin.next = undefined; return pinned }
    return hex(16)
  }
  generateSpanId(): string { return hex(8) }
}

export interface Runtime {
  processor: LangfuseSpanProcessor
  provider: NodeTracerProvider
  pin: TraceIdPin
  forceFlush(timeoutMs: number): Promise<void>
  shutdown(timeoutMs: number): Promise<void>
}

export function createRuntime(config: Resolved): Runtime {
  const pin: TraceIdPin = { next: undefined }
  const secrets = [...environmentSecrets(), config.publicKey, config.secretKey]
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    environment: config.environment,
    ...(config.release === '' ? {} : { release: config.release }),
    // Second line of defence after capture(): everything serialized into attributes goes through the redactor.
    mask: ({ data }) => {
      if (typeof data === 'string') {
        try { return JSON.stringify(sanitize(JSON.parse(data), secrets, [], false)) } catch { return redactString(data, secrets, false) }
      }
      return sanitize(data, secrets, [], false)
    },
    shouldExportSpan: ({ otelSpan }) => typeof otelSpan.attributes['langfuse.observation.type'] === 'string',
  })
  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
    sampler: new AlwaysOnSampler(),
    idGenerator: new PinnedIdGenerator(pin),
    spanLimits: { attributeValueLengthLimit: Infinity, attributeCountLimit: Infinity },
  })
  setLangfuseTracerProvider(provider)
  const race = async (work: Promise<unknown>, ms: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
    if (timer !== undefined) clearTimeout(timer)
  }
  return {
    processor, provider, pin,
    forceFlush: (ms) => race(processor.forceFlush(), ms),
    shutdown: async (ms) => {
      await race(processor.forceFlush(), ms)
      await race(provider.shutdown(), ms)
      setLangfuseTracerProvider(null)
    },
  }
}

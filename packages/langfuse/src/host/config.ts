import Schema from '@deepseek-ai/schemastery'

/** USD per 1M tokens. Used only for routes Langfuse cannot price itself. */
export interface Price { input: number; output: number; cacheRead?: number; cacheWrite?: number }

export interface Config {
  /** Master switch. `LANGFUSE_TRACING_ENABLED=false` also disables. */
  enabled: boolean
  /** Langfuse base URL; empty = `LANGFUSE_BASE_URL` or http://127.0.0.1:3001. */
  baseUrl: string
  /** Trace environment; empty = `LANGFUSE_TRACING_ENVIRONMENT` or `dsh`. */
  environment: string
  release: string
  /** Langfuse user id; empty = `LANGFUSE_USER_ID`. */
  userId: string
  /** `full` captures prompts/outputs, `metadata` keeps only sizes and timings, `off` records structure only. */
  captureContent: 'full' | 'metadata' | 'off'
  includeReasoning: boolean
  includeSystemPrompt: boolean
  /** Per-field cap on serialized input/output characters (head+tail excerpt beyond it). */
  maxChars: number
  /** Fraction of turns traced (0–1); children follow their parent turn. */
  sampleRate: number
  /** Auxiliary LLM purposes that are not traced (e.g. `session-title`). */
  excludePurposes: string[]
  /** Tools whose arguments and results are never captured. */
  redactTools: string[]
  tags: string[]
  /** `provider/model` or `model` → price table. */
  pricing: Record<string, Price>
  flushTimeoutMs: number
  /** Show the "Open trace" action under assistant messages. */
  openTraceButton: boolean
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  baseUrl: Schema.string().default(''),
  environment: Schema.string().default(''),
  release: Schema.string().default(''),
  userId: Schema.string().default(''),
  captureContent: Schema.union(['full', 'metadata', 'off'] as const).default('full'),
  includeReasoning: Schema.boolean().default(true),
  includeSystemPrompt: Schema.boolean().default(true),
  maxChars: Schema.number().default(500_000),
  sampleRate: Schema.number().default(1),
  excludePurposes: Schema.array(String).default([]),
  redactTools: Schema.array(String).default([]),
  tags: Schema.array(String).default([]),
  pricing: Schema.dict(Schema.object({
    input: Schema.number().required(),
    output: Schema.number().required(),
    cacheRead: Schema.number(),
    cacheWrite: Schema.number(),
  })).default({}),
  flushTimeoutMs: Schema.number().default(3000),
  openTraceButton: Schema.boolean().default(true),
}) as Schema<Config>

export interface Resolved extends Omit<Config, 'baseUrl' | 'environment' | 'userId'> {
  baseUrl: string
  environment: string
  userId: string | undefined
  publicKey: string
  secretKey: string
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:3001'

/** Merge config, env and credentials into the effective settings; undefined when tracing cannot run. */
export async function resolveConfig(
  config: Config,
  env: NodeJS.ProcessEnv,
  readCredential: (name: string) => Promise<string | undefined>,
): Promise<{ resolved: Resolved } | { disabled: string }> {
  if (!config.enabled) return { disabled: 'disabled in config' }
  if (env['LANGFUSE_TRACING_ENABLED']?.trim().toLowerCase() === 'false') return { disabled: 'LANGFUSE_TRACING_ENABLED=false' }
  const publicKey = env['LANGFUSE_PUBLIC_KEY']?.trim() || await readCredential('LANGFUSE_PUBLIC_KEY')
  const secretKey = env['LANGFUSE_SECRET_KEY']?.trim() || await readCredential('LANGFUSE_SECRET_KEY')
  if (!publicKey || !secretKey) return { disabled: 'no Langfuse keys (set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)' }
  const baseUrl = (config.baseUrl || env['LANGFUSE_BASE_URL'] || env['LANGFUSE_HOST'] || DEFAULT_BASE_URL).replace(/\/+$/, '')
  return {
    resolved: {
      ...config,
      baseUrl,
      environment: config.environment || env['LANGFUSE_TRACING_ENVIRONMENT'] || 'dsh',
      userId: config.userId || env['LANGFUSE_USER_ID'] || undefined,
      sampleRate: Math.min(1, Math.max(0, Number.isFinite(config.sampleRate) ? config.sampleRate : 1)),
      maxChars: Number.isFinite(config.maxChars) && config.maxChars >= 1000 ? Math.floor(config.maxChars) : 500_000,
      publicKey,
      secretKey,
    },
  }
}

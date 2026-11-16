import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { DEFAULT_MAX_FETCH_CHARS, ParallelFetchProvider } from './fetch.ts'
import {
  DEFAULT_MAX_CHARS_TOTAL,
  ParallelSearchProvider,
  type ParallelSearchMode,
} from './provider.ts'

export { DEFAULT_MAX_CHARS_TOTAL, PARALLEL_PROVIDER_ID } from './provider.ts'
export { DEFAULT_MAX_FETCH_CHARS } from './fetch.ts'
export type { ParallelSearchMode } from './provider.ts'

export const name = 'web-search-parallel'
export const inject = ['web']

export interface Config {
  apiKey?: string
  mode?: ParallelSearchMode
  maxCharsTotal?: number
  maxCharsPerResult?: number
  maxFetchChars?: number
}

interface ResolvedConfig extends Config {
  maxCharsTotal: number
}

// DSH 0.2 schemastery types widen defaulted fields to `number | Volatile<number>`;
// these fields are not volatile, so the runtime value is a plain number.
export const Config: z<Config, ResolvedConfig> = z.object({
  apiKey: z.string(),
  mode: z.union(['turbo', 'basic', 'advanced'] as const),
  maxCharsTotal: z.number().step(1).min(1).default(DEFAULT_MAX_CHARS_TOTAL),
  maxCharsPerResult: z.number().step(1).min(1),
  maxFetchChars: z.number().step(1).min(1),
}) as unknown as z<Config, ResolvedConfig>

export function apply(ctx: Context, config: ResolvedConfig): void {
  const apiKey = config.apiKey ?? launchEnvironmentOf(ctx).get('PARALLEL_API_KEY')?.value ?? ''
  ctx.web.registerFetchProvider(new ParallelFetchProvider({
    apiKey,
    maxFetchChars: config.maxFetchChars ?? DEFAULT_MAX_FETCH_CHARS,
  }))
  ctx.web.registerSearchProvider(new ParallelSearchProvider({
    apiKey,
    ...(config.mode === undefined ? {} : { mode: config.mode }),
    maxCharsTotal: config.maxCharsTotal,
    ...(config.maxCharsPerResult === undefined ? {} : { maxCharsPerResult: config.maxCharsPerResult }),
  }))
}

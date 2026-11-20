/** Plugin configuration (the `ohmydsh-brand` patch row). Invalid values fall back to the default; never throws. */
export interface BrandConfig {
  /** Show ohmydsh instead of the DeepSeek Harness marks. `false` leaves the stock look (and removes the routes). */
  readonly enabled: boolean
  /** Keep the visible "Built on DeepSeek Harness" credit (Settings > General and the sidebar name tooltip). */
  readonly showAttribution: boolean
}

export const GLOBAL_NAME = '__OHMYDSH_BRAND__'
export const PRODUCT_NAME = 'ohmydsh'
/** DeepSeek's official Harness page, the target of the attribution link. */
export const HARNESS_URL = 'https://github.com/deepseek-ai/deepseek-harness'

export function readConfig(raw: unknown): BrandConfig {
  const cfg = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { enabled: cfg['enabled'] !== false, showAttribution: cfg['showAttribution'] !== false }
}

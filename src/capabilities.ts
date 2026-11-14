/**
 * Per-provider output parameter capabilities (aspect ratios, quality tiers)
 * and the ratio→wire-size mappings, aligned with vendor docs as of 2026-09:
 *
 * - google (gemini-3.1-flash-image): 14 ratios incl. extremes, 512/1K/2K/4K.
 *   We expose the 10 common ratios; extreme strips (1:4/4:1/1:8/8:1) and the
 *   Flash-only 512 tier stay out (512 breaks when the user switches to a pro
 *   model, and tiny outputs have no real use case here).
 * - openai (gpt-image-2 series, default gpt-image-2.6-flare): any WIDTHxHEIGHT
 *   with 16-divisible edges, ratio within 1:3–3:1, ≤3840x2160; quality
 *   low/medium/high/auto.
 * - xai (grok-imagine-image-2.0): NO size parameter at all — aspect_ratio (15
 *   values incl. auto) + resolution 1k/2k.
 * - grok-sub (grok-imagine-image-2.0): aspect_ratio + resolution 1k/2k.
 * - google-sub (gemini-3.1-flash-image): 10 ratios + imageSize 1K/2K/4K (we expose
 *   standard/HD → default/4K).
 */
import type { CloudImageProvider, StudioOption, SubscriptionProvider } from './shared.js'

/** English labels shared by the server-side profiles. */
export const RATIO_LABELS: Record<string, string> = {
  auto: 'Auto',
  '1:1': '1:1 square',
  '3:2': '3:2 landscape',
  '2:3': '2:3 portrait',
  '4:3': '4:3 landscape',
  '3:4': '3:4 portrait',
  '4:5': '4:5 portrait',
  '5:4': '5:4 landscape',
  '3:1': '3:1 panorama',
  '1:3': '1:3 strip',
  '21:9': '21:9 ultrawide',
  '9:21': '9:21 ultratall',
}

function ratioOption(value: string): StudioOption {
  return { value, label: RATIO_LABELS[value] ?? value }
}

/** 16-divisible pixel sizes for the OpenAI-shape free-size contract. */
const OPENAI_SIZE_TABLE: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '1152x864',
  '3:4': '864x1152',
  '16:9': '1536x864',
  '9:16': '864x1536',
}

export interface ProviderCapability {
  ratioOptions: StudioOption[]
  qualityOptions: StudioOption[]
  defaultRatio: string
  defaultQuality: string
  /**
   * Resolve the wire `size` for providers that speak pixel dimensions
   * (openai). Returns undefined when the
   * channel takes no size (ratio `auto`) so the vendor default applies.
   */
  sizeFor?(ratio: string, quality: string): string | undefined
}

function capability(
  ratios: string[],
  qualities: StudioOption[],
  defaultRatio: string,
  defaultQuality: string,
  sizeFor?: ProviderCapability['sizeFor'],
): ProviderCapability {
  return { ratioOptions: ratios.map(ratioOption), qualityOptions: qualities, defaultRatio, defaultQuality, ...(sizeFor === undefined ? {} : { sizeFor }) }
}

const AUTO = { value: 'auto', label: 'Auto' }
const STANDARD = { value: 'standard', label: 'Standard (recommended)' }

export const CLOUD_CAPABILITIES: Record<Exclude<CloudImageProvider, 'openai-compat'>, ProviderCapability> = {
  google: capability(
    ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'],
    ['1K', '2K', '4K'].map(value => ({ value, label: value })),
    '1:1',
    '1K',
  ),
  openai: capability(
    Object.keys(OPENAI_SIZE_TABLE),
    [AUTO, ...['low', 'medium', 'high'].map(value => ({ value, label: value }))],
    '1:1',
    'auto',
    ratio => OPENAI_SIZE_TABLE[ratio] ?? '1024x1024',
  ),
  xai: capability(
    ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
    [{ value: '1k', label: '1K' }, { value: '2k', label: '2K' }],
    'auto',
    '1k',
  ),
}

/** The pickers of a cloud row. */
export function cloudCapability(provider: Exclude<CloudImageProvider, 'openai-compat'>, _model: string): ProviderCapability {
  return CLOUD_CAPABILITIES[provider]
}

export const SUBSCRIPTION_CAPABILITIES: Record<SubscriptionProvider, ProviderCapability> = {
  'grok-sub': capability(
    ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
    [{ value: '1k', label: '1K' }, { value: '2k', label: '2K' }],
    'auto',
    '1k',
  ),
  'google-sub': capability(
    ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'],
    [STANDARD, { value: 'hd', label: 'HD (4K)' }],
    'auto',
    'standard',
  ),
}

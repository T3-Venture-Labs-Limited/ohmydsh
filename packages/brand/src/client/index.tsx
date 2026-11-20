// Browser half. Slots first (sidebar mark + name, new-session hero mark, Settings credit), then the tab title.
// Nothing heavy: no lazy chunks are needed. One `ctx.effect` per resource, so disabling the plugin restores stock.
import type { Context } from '@deepseek-ai/cordis'
import { GLOBAL_NAME, readConfig } from '../shared/config.ts'
import type { BrandConfig } from '../shared/config.ts'
import { Attribution } from './attribution.tsx'
import { locale } from './locale.ts'
import { BrandMark, BrandWordmark } from './marks.tsx'
import { followTitle } from './title.ts'

export const inject = ['slots', 'locale']

/**
 * A single slot refuses a second registration at the same priority, and the shipped DSH already fills the sidebar mark
 * and name at the default priority 0 (the official artwork). Priority is "lowest renders", so -1 shadows it cleanly
 * whichever plugin activates first, and leaves the stock occupant in place (untouched) for when this plugin is off.
 */
const STOCK_PRIORITY = -1

/** The host writes the settings row into the page as a global; a page without it (tests, old host) gets the defaults. */
export function pageConfig(scope: Record<string, unknown> = globalThis as Record<string, unknown>): BrandConfig {
  return readConfig(scope[GLOBAL_NAME])
}

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; slots: any } // eslint-disable-line
  const config = pageConfig()
  if (!config.enabled) return
  ctx.effect(() => locale.register(c.locale), 'ohmydsh-brand: dictionary')
  const t = locale.bind(c.locale)

  // Sidebar: the mark (also the collapsed rail's only brand) and the name that stands where "deepseek HARNESS" was.
  c.slots.inject('sidebar.brand.mark', () => c.slots.register({ name: 'sidebar.brand.mark', priority: STOCK_PRIORITY }, BrandMark))
  c.slots.inject('sidebar.brand.name', () => c.slots.register({ name: 'sidebar.brand.name', priority: STOCK_PRIORITY }, () => <BrandWordmark title={config.showAttribution ? t('builtOnTooltip') : t('productName')} />))
  // New-session hero: the mark before the headline.
  c.slots.inject('conversation.hero.brand.mark', () => c.slots.register({ name: 'conversation.hero.brand.mark', priority: STOCK_PRIORITY }, BrandMark))
  // Settings > General: the credit, right after the version row (order 100).
  if (config.showAttribution) {
    c.slots.inject('settings.general.item', () => c.slots.register({ name: 'settings.general.item', id: 'ohmydsh-attribution', order: 101 }, () => <Attribution t={t} />))
  }
  if (typeof document !== 'undefined') ctx.effect(() => followTitle(document), 'ohmydsh-brand: tab title')
}

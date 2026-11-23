// Browser half. Nothing here is on the boot path beyond a stylesheet and a few listeners: no React, no slots, no lazy chunks.
// Every resource is one `ctx.effect`, so disabling the plugin removes the listeners, the stylesheet and the attributes.
import type { Context } from '@deepseek-ai/cordis'
import { GLOBAL_NAME, readConfig } from '../shared/config.ts'
import type { KeysConfig } from '../shared/config.ts'
import { createController } from './controller.ts'
import { locale } from './locale.ts'
import { focusKeysText, registerShortcuts } from './shortcuts.ts'
import type { ShortcutsFace } from './shortcuts.ts'
import { mountStyle } from './styles.ts'

export const inject = ['locale', 'shortcuts']

/** The host writes the settings row into the page as a global; a page without it (tests, old host) gets the defaults. */
export function pageConfig(scope: Record<string, unknown> = globalThis as Record<string, unknown>): KeysConfig {
  return readConfig(scope[GLOBAL_NAME])
}

export function apply(ctx: Context): void {
  const c = ctx as Context & { locale: Parameters<typeof locale.register>[0]; shortcuts: ShortcutsFace }
  const config = pageConfig()
  if (!config.enabled || typeof document === 'undefined') return
  ctx.effect(() => locale.register(c.locale), 'ohmydsh-keys: dictionary')
  const t = locale.bind(c.locale)
  ctx.effect(() => mountStyle(document), 'ohmydsh-keys: stylesheet')
  const controller = createController({ doc: document, config, t: t as never, focusKeys: () => focusKeysText(c.shortcuts) })
  ctx.effect(() => controller.start(), 'ohmydsh-keys: keyboard')
  // A rebound (or cleared) focus shortcut changes the hint text on a waiting card.
  ctx.effect(() => c.shortcuts.catalog.subscribe(() => { controller.refresh() }), 'ohmydsh-keys: shortcut labels')
  registerShortcuts((fn, label) => { ctx.effect(fn as never, label) }, c.shortcuts, t, (from) => controller.focusWaiting(from))
}

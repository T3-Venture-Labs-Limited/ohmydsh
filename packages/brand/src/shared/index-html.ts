import { GLOBAL_NAME, PRODUCT_NAME } from './config.ts'
import type { BrandConfig } from './config.ts'

/** Stock files the shell's index.html and manifest point at; the host serves ohmydsh's at the same paths. */
export const ICON_PATHS = ['/favicon.svg', '/favicon-dark.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'] as const

/**
 * Boot splash: while plugins load, the shell's kernel page shows the word "HARNESS" (plain DOM with hashed class names
 * and no slot; it exists before any plugin runs). This inline script waits for exactly that element (a `[data-dsh-boot]`
 * descendant whose whole text is "HARNESS"), swaps in the product name once, then disconnects (also after 20 s).
 * A DSH update that changes the splash leaves it untouched, and tests/selector-guard.spec.ts fails on the change.
 */
export const BOOT_SCRIPT = `(function(){var N=${JSON.stringify(PRODUCT_NAME)};function fix(){var b=document.querySelector("[data-dsh-boot]");if(!b)return false;var w=b.querySelectorAll("div");for(var i=0;i<w.length;i++){if(w[i].children.length===0&&w[i].textContent==="HARNESS"){w[i].textContent=N;return true}}return false}`
  + `if(fix())return;var o=new MutationObserver(function(){if(fix())o.disconnect()});o.observe(document.documentElement,{childList:true,subtree:true});setTimeout(function(){o.disconnect()},20000)})()`

/**
 * Rewrite the stock index.html: tab title, installed-app title, icon links (cache-busted). Pure and idempotent.
 * Only attributes this function knows are touched; an unknown index passes through unchanged.
 */
export function brandIndex(html: string, version: string): string {
  let out = html.replace(/<title>[^<]*<\/title>/i, `<title>${PRODUCT_NAME}</title>`)
  out = out.replace(/(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/i, `$1${PRODUCT_NAME}$2`)
  out = out.replace(/(<link\s[^>]*href="\.?\/?)(favicon(?:-dark)?\.svg|apple-touch-icon\.png)(")/gi, `$1$2?ohmydsh=${version}$3`)
  return out
}

/** The rows the host adds to the page: configuration for the client half and the boot-splash script. */
export function brandRows(config: BrandConfig): unknown[] {
  return [
    { kind: 'global', name: GLOBAL_NAME, value: { enabled: config.enabled, showAttribution: config.showAttribution } },
    ...(config.enabled ? [{ kind: 'script', placement: 'head', text: BOOT_SCRIPT }] : []),
  ]
}

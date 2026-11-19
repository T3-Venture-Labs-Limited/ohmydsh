// DOM side of the dsh-theme-endfield compatibility (see src/shared/endfield.ts for the token side).
//
// Detection: endfield (MIT, github:ymh0000123/dsh-theme-endfield) mounts one <style data-plugin="dsh-theme-endfield"> in <head>
// while it is switched on and removes it when switched off, so that element is the single source of truth.
//
// Ink bridge: endfield hard-codes ink colours (#000, #101110, #fff) for text that sits on its accent fill, with `!important`.
// Against an Omarchy accent that can be unreadable (black on a dark accent). Rather than copy its selectors, we read them
// from its own stylesheet (CSSOM) and emit `html :is(<its selector>) { color: var(--edge-on-accent) !important }`, which
// out-ranks the original by one type selector and follows whatever version is installed. `--edge-on-accent` is a token in our
// layer (black or white, whichever reads better on the Omarchy accent). Geometry is never touched.

export const ENDFIELD_SELECTOR = 'style[data-plugin="dsh-theme-endfield"]'
const BRIDGE_ATTR = 'data-dsh-theme-endfield-bridge'
const ON_ACCENT = 'var(--edge-on-accent)'
// Chrome serialises #000 as rgb(0, 0, 0); jsdom keeps the hex.
const INK = /^(#000|#000000|#101110|rgb\(\s*0,\s*0,\s*0\s*\)|rgb\(\s*16,\s*17,\s*16\s*\))$/i // artwork:ok
const WHITE = /^(#fff|#ffffff|rgb\(\s*255,\s*255,\s*255\s*\))$/i // artwork:ok

export interface EndfieldFace {
  present(): boolean
  /** Called when endfield appears, disappears or swaps its stylesheet; returns a disposer. */
  subscribe(listener: () => void): () => void
  /** Install (true) or remove (false) the ink bridge stylesheet. Idempotent. */
  bridge(on: boolean): void
}

type DocLike = Pick<Document, 'head' | 'querySelector' | 'createElement'>

/** Pure: turn endfield's rules into bridge CSS. Exposed for tests. */
export function inkRules(rules: readonly { selectorText: string; style: { getPropertyValue(n: string): string; getPropertyPriority(n: string): string } }[]): string {
  const out: string[] = []
  for (const rule of rules) {
    const sel = rule.selectorText
    if (typeof sel !== 'string' || sel === '' || sel.includes('endfield-') || sel.includes('::') || sel.includes('confirmation') || sel.includes('data-approval-key')) continue
    const color = rule.style.getPropertyValue('color').trim()
    const bg = rule.style.getPropertyValue('background-color').trim() || rule.style.getPropertyValue('background').trim()
    const decl: string[] = []
    const lightSidebarIcons = sel.includes(':not([data-ds-dark-theme])') && sel.includes('_sidebarCol') && !sel.includes(':hover')
    if (rule.style.getPropertyPriority('color') === 'important' && (INK.test(color) || (WHITE.test(color) && sel.includes('_primary')))) {
      // Ink on paper (light sidebar icons) must follow the text colour, not the accent contrast colour.
      decl.push(`color: ${lightSidebarIcons ? 'var(--dsw-alias-label-primary)' : ON_ACCENT} !important`)
    }
    if (INK.test(bg) && (rule.style.getPropertyPriority('background') === 'important' || rule.style.getPropertyPriority('background-color') === 'important')) decl.push(`background: ${ON_ACCENT} !important`)
    if (decl.length === 0) continue
    // Sidebar rows are a translucent wash in light mode (text stays ink) and a solid accent fill in dark mode.
    if (/_(sessionRow|projectRow|searchResultRow)/.test(sel) && decl[0]?.startsWith('color')) {
      out.push(`html body:not([data-ds-dark-theme]) :is(${sel}) { color: var(--dsw-alias-label-primary) !important }`)
      out.push(`html body[data-ds-dark-theme] :is(${sel}) { ${decl.join('; ')} }`)
    } else out.push(`html :is(${sel}) { ${decl.join('; ')} }`)
  }
  out.push(`html ::selection { color: ${ON_ACCENT} }`)
  // Endfield paints the selected tab of any dialog in white (it assumes a dark pill); our own segmented control keeps a light pill.
  out.push('html body:not([data-ds-dark-theme]) [role="dialog"] .dk-segmented__tab[aria-selected="true"] { color: var(--dsw-alias-label-primary) !important }')
  return out.join('\n')
}

export function createEndfieldFace(doc: DocLike | undefined = typeof document === 'undefined' ? undefined : document): EndfieldFace {
  const listeners = new Set<() => void>()
  let observer: MutationObserver | undefined
  let sheetText: string | undefined
  let bridgeOn = false
  let bridgeEl: HTMLStyleElement | undefined

  const source = (): HTMLStyleElement | null => (doc?.querySelector(ENDFIELD_SELECTOR) ?? null) as HTMLStyleElement | null
  const present = (): boolean => source() !== null

  const build = (): void => {
    const src = source()
    if (!bridgeOn || src === null || doc === undefined) { bridgeEl?.remove(); bridgeEl = undefined; return }
    let css = ''
    try { css = inkRules(Array.from(src.sheet?.cssRules ?? []).filter((r): r is CSSStyleRule => 'selectorText' in r)) } catch { css = '' }
    if (bridgeEl === undefined) {
      bridgeEl = doc.createElement('style')
      bridgeEl.setAttribute(BRIDGE_ATTR, '')
    }
    if (bridgeEl.textContent !== css) bridgeEl.textContent = css
    // Last in <head>, after endfield's sheet: equal specificity would also lose to us on order.
    if (bridgeEl.parentNode !== doc.head || bridgeEl.previousSibling !== src) src.after(bridgeEl)
  }

  const onMutation = (): void => {
    const src = source()
    const text = src?.textContent ?? undefined
    const changed = (text === undefined) !== (sheetText === undefined) || text !== sheetText
    if (!changed && (src === null || bridgeEl === undefined || !bridgeOn)) return
    sheetText = text
    build()
    if (changed) for (const l of [...listeners]) l()
  }

  const watch = (): void => {
    if (observer !== undefined || doc === undefined || typeof MutationObserver === 'undefined') return
    sheetText = source()?.textContent ?? undefined
    // Only <head> children are watched (endfield's sheet and, on re-mount, its replacement): no subtree, no attributes.
    observer = new MutationObserver(onMutation)
    observer.observe(doc.head, { childList: true })
  }
  const unwatch = (): void => { if (listeners.size === 0 && !bridgeOn) { observer?.disconnect(); observer = undefined } }

  return {
    present,
    subscribe(listener) {
      listeners.add(listener); watch()
      return () => { listeners.delete(listener); unwatch() }
    },
    bridge(on) {
      bridgeOn = on
      if (on) watch()
      build()
      unwatch()
    },
  }
}

// DOM side of the Endfield look and of glass: one <style> element each in <head>, present only while that feature is on.

export const LOOK_ATTR = 'data-dsh-theme-look'

export interface LookFace {
  /** Mount `css` (replacing any previous text), or remove the stylesheet when `css` is undefined. Idempotent. */
  apply(css: string | undefined): void
}

/** `name` is the attribute value that tells the two stylesheets apart ('endfield' | 'glass'). */
export function createLookFace(doc: Pick<Document, 'head' | 'createElement'> | undefined = typeof document === 'undefined' ? undefined : document, name = 'endfield'): LookFace {
  let el: HTMLStyleElement | undefined
  return {
    apply(css) {
      if (doc === undefined) return
      if (css === undefined) { el?.remove(); el = undefined; return }
      if (el === undefined) {
        el = doc.createElement('style')
        el.setAttribute(LOOK_ATTR, name)
      }
      if (el.textContent !== css) el.textContent = css
      if (el.parentNode !== doc.head) doc.head.appendChild(el)
    },
  }
}

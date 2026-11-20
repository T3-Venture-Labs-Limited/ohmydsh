/**
 * The product name shown to the person using the app. One source: the plugin config (`name`, `shortName`), threaded into
 * every page and script generator here. The default is ohmydsh; on stock DeepSeek Harness set `name: DeepSeek Harness`
 * and `shortName: DSH` in the plugin row to get the old wording back.
 */
export interface Product {
  /** Full name: page titles and sentences. */
  readonly name: string
  /** Short name: the launcher label (manifest `short_name`). */
  readonly shortName: string
}

export const DEFAULT_PRODUCT: Product = { name: 'ohmydsh', shortName: 'ohmydsh' }

/** Escape for HTML text and attribute values. */
export function html(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** A JS string literal that is safe inside a `<script>` body and inside a template that is itself JS source. */
export function js(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

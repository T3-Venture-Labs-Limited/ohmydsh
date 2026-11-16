// Pure naming helpers shared by the host and the page.

/** "google_maps" -> "Google Maps", "_1password" -> "1password". Only a fallback for when the catalog has no name. */
export function prettifySlug(slug: string): string {
  const words = slug.replace(/^_+/, '').split(/[_-]+/).filter((w) => w !== '')
  if (words.length === 0) return slug
  return words.map((w) => (w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
}

/** Only plain https logo URLs are passed on to the page (an <img> src); anything else is dropped. */
export function safeLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null
  } catch { return null }
}

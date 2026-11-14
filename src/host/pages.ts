import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** Static files of the /m page, read from `<package>/public/m/`. */
export interface PageFile {
  readonly body: Buffer
  readonly type: string
  /** Short content hash, used as the `?v=` cache-busting revision. */
  readonly rev: string
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export const PAGE_ASSETS = ['events.js', 'app.js', 'app.css'] as const

export async function loadPageFile(publicDir: URL, name: string): Promise<PageFile> {
  const body = await readFile(new URL(`m/${name}`, publicDir))
  const ext = name.slice(name.lastIndexOf('.'))
  return { body, type: TYPES[ext] ?? 'application/octet-stream', rev: createHash('sha1').update(body).digest('hex').slice(0, 10) }
}

/** Escape a value for a double-quoted HTML attribute. */
export function attr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Render the /m document. The DSH stylesheets (the real theme tokens) are linked by the hrefs the host's own index uses.
 * Nothing request-specific or secret is embedded: the page is the same for every signed-in browser.
 */
export function renderMobileIndex(options: { stylesheets: readonly string[]; appRev: string; cssRev: string; eventsRev?: string; name: string }): string {
  const links = options.stylesheets.map((href) => `<link rel="stylesheet" href="${attr(href)}">`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${attr(options.name)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${links}
<link rel="stylesheet" href="/m/app.css?v=${options.cssRev}">
</head>
<body class="pwa-body">
<div id="app" role="application" aria-label="${attr(options.name)}"></div>
<noscript><p style="padding:16px">This page needs JavaScript.</p></noscript>
<script src="/m/events.js?v=${options.eventsRev ?? options.appRev}" defer></script>
<script src="/m/app.js?v=${options.appRev}" defer></script>
</body>
</html>
`
}

/** Pull stylesheet hrefs out of the host's rendered index.html, as absolute paths. */
export function stylesheetHrefs(indexHtml: string): string[] {
  const out: string[] = []
  for (const match of indexHtml.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)) {
    const href = /\bhref="([^"]+)"/i.exec(match[0])?.[1]
    if (href === undefined || /^[a-z]+:|^\/\//i.test(href)) continue
    const path = href.startsWith('/') ? href : `/${href.replace(/^\.\//, '')}`
    if (/^\/assets\/[A-Za-z0-9_.-]+\.css$/.test(path)) out.push(path)
  }
  return out
}

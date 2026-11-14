import type { PwaConfig } from './config.ts'

/**
 * Web app manifest, served at `/manifest.webmanifest` instead of the stock one (same icons, so the install icon stays
 * the DSH brand mark). `scope: "/"` keeps the full DSH UI and `/m` inside the installed app.
 */
export function buildManifest(config: PwaConfig): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    id: '/',
    name: config.name,
    short_name: config.shortName,
    description: 'DeepSeek Harness: read and reply to sessions and approve tool calls from your phone.',
    start_url: config.startUrl,
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: config.backgroundColor,
    theme_color: config.themeColor,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Sessions and approvals', short_name: 'Phone view', url: '/m', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      { name: 'Full DSH', short_name: 'DSH', url: '/', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] },
    ],
  }
  if (config.share.enabled) {
    manifest['share_target'] = {
      action: '/share',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['*/*'] }] },
    }
  }
  return manifest
}

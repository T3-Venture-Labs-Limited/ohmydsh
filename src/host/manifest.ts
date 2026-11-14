import type { PwaConfig } from './config.ts'

/**
 * Web app manifest, served at `/manifest.webmanifest` instead of the stock one (same icons, so the install icon stays
 * the DSH brand mark). The installed app is the normal DSH UI: `start_url` and `scope` are `/`, so it opens full-screen
 * on the same origin and shares the browser's HttpOnly sign-in cookie.
 */
export function buildManifest(config: PwaConfig): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    id: '/',
    name: config.name,
    short_name: config.shortName,
    description: 'DeepSeek Harness as an app, with notifications when a session needs you or a reply is ready.',
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

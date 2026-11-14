// English dictionary: the typed source of truth for every UI string of the settings page.
import { defineLocale } from '../kit/locale.ts'

export const locale = defineLocale('dsh-pwa', {
  nav: 'Phone app',
  pageTitle: 'Phone app',
  pageDescription: 'Install DSH as an app and use the light phone view. Everything here runs on your own computer.',
  sectionInstall: 'Install',
  installTitle: 'Install DSH',
  installDescription: 'Adds DSH to your home screen or app launcher. Works over HTTPS or on localhost.',
  installButton: 'Install',
  installUnavailable: 'Not available here',
  installDone: 'Installed',
  insecure: 'This page is not a secure context (plain http over the network). Enable Tailscale HTTPS, or open DSH on localhost, to install it.',
  swTitle: 'Offline shell',
  swDescription: 'A service worker caches public, versioned files so the app opens faster. It never caches /api or anything signed-in.',
  swActive: 'Active',
  swInactive: 'Not active',
  swUnsupported: 'Not supported in this browser',
  sectionPhone: 'Phone view',
  openTitle: 'Open the phone view',
  openDescription: 'A light page for reading sessions, replying and approving tool calls. Bookmark /m on your phone.',
  openButton: 'Open /m',
  shareTitle: 'Share to DSH',
  shareDescription: 'After installing on Android, share text, links or files to DSH from any app. They land in the phone view as a draft.',
  sectionNotify: 'Notifications',
  notifyTitle: 'Push without an app store',
  notifyDescription: 'Use the notify-me plugin\'s custom webhook with an ntfy topic on your tailnet, then install the ntfy Android app. See the plugin README for the exact steps.',
  notifyPermission: 'Browser notifications',
  notifyEnable: 'Enable',
  notifyGranted: 'Allowed',
  notifyDenied: 'Blocked in browser settings',
})
export type T = ReturnType<typeof locale.bind>

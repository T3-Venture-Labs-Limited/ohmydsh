'use strict'
// Auto-update of the app itself through electron-updater, from GitHub Releases (publish config in electron-builder.yml).
// Unsigned builds update fine on Linux (AppImage). On Windows an unsigned installer shows SmartScreen again, and macOS
// refuses to apply an unsigned update: there we only announce it and link to the Releases page (see docs/APPS.md).

function canSelfUpdate({ platform, packaged, appImage, signed }) {
  if (!packaged) return false
  if (platform === 'linux') return Boolean(appImage)
  if (platform === 'win32') return true
  return Boolean(signed) // macOS needs a signed app
}

function startUpdater({ autoUpdater, platform, packaged, env, signed, log, notify, enabled }) {
  if (!enabled || env.OHMYDSH_NO_UPDATE === '1') return { check() {}, active: false }
  const self = canSelfUpdate({ platform, packaged, appImage: env.APPIMAGE, signed })
  if (!self) return { check() {}, active: false, reason: 'self-update is not available for this build; see the Releases page' }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: (m) => log(`updater: ${m}`), warn: (m) => log(`updater: ${m}`), error: (m) => log(`updater: ${m}`), debug: () => {} }
  autoUpdater.on('update-available', (i) => notify({ kind: 'available', version: i.version }))
  autoUpdater.on('update-downloaded', (i) => notify({ kind: 'downloaded', version: i.version }))
  autoUpdater.on('error', (e) => log(`updater error: ${e?.message ?? e}`))
  return { check: () => { autoUpdater.checkForUpdates().catch((e) => log(`updater: ${e.message}`)) }, active: true }
}

module.exports = { startUpdater, canSelfUpdate }

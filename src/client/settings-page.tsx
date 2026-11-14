// Settings page (lazy chunk): install state, service worker state, phone notifications.
import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Page, Section, SettingsRow } from '../kit/index.ts'
import type { T } from './locale.ts'
import { currentSubscription, disablePush, enablePush, pushSupport, resync, sendTest } from './push-client.ts'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function deviceName(): string {
  const ua = navigator.userAgent
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Device'
  const app = window.matchMedia('(display-mode: standalone)').matches ? 'app' : 'browser'
  return `${os} ${app}`
}

export default function SettingsPage({ t }: { t: T }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches)
  const [sw, setSw] = useState<'checking' | 'active' | 'inactive' | 'unsupported'>('checking')
  const support = pushSupport()
  const [subscribed, setSubscribed] = useState<boolean | undefined>(undefined)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => ('Notification' in window ? Notification.permission : 'unsupported'))
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    const onPrompt = (event: Event): void => { event.preventDefault(); setPrompt(event as InstallPromptEvent) }
    const onInstalled = (): void => { setInstalled(true); setPrompt(null) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) { setSw('unsupported'); return }
    let alive = true
    void navigator.serviceWorker.getRegistration('/').then((registration) => {
      if (alive) setSw(registration?.active !== null && registration?.active !== undefined ? 'active' : 'inactive')
    })
    return () => { alive = false }
  }, [])

  // Read-only on load: no permission prompt, no subscribing. An existing subscription is re-stored quietly (idempotent).
  useEffect(() => {
    if (support !== 'ok') { setSubscribed(false); return }
    let alive = true
    void currentSubscription().then((subscription) => {
      if (!alive) return
      setSubscribed(subscription !== null && Notification.permission === 'granted')
      if (subscription !== null && Notification.permission === 'granted') void resync(subscription)
    }).catch(() => { if (alive) setSubscribed(false) })
    return () => { alive = false }
  }, [support])

  const run = useCallback(async (action: () => Promise<void>, ok?: string): Promise<void> => {
    setBusy(true); setNotice(null)
    try { await action(); if (ok !== undefined) setNotice({ text: ok, error: false }) }
    catch (error) { setNotice({ text: t('notifyError', { message: (error as Error).message }), error: true }) }
    finally { setBusy(false); if ('Notification' in window) setPermission(Notification.permission) }
  }, [t])

  const install = async (): Promise<void> => {
    if (prompt === null) return
    await prompt.prompt()
    await prompt.userChoice
    setPrompt(null)
  }

  const secure = window.isSecureContext
  const status = support === 'insecure' ? t('notifyStatusInsecure')
    : support === 'unsupported' ? t('notifyStatusUnsupported')
      : permission === 'denied' ? t('notifyStatusBlocked')
        : subscribed === true ? t('notifyStatusOn') : t('notifyStatusOff')
  const canToggle = support === 'ok' && permission !== 'denied' && subscribed !== undefined

  return (
    <Page title={t('pageTitle')} description={t('pageDescription')}>
      <Section title={t('sectionInstall')}>
        <Card>
          <SettingsRow title={t('installTitle')} description={secure ? t('installDescription') : t('insecure')}>
            {installed
              ? <span>{t('installDone')}</span>
              : <Button variant="primary" disabled={prompt === null} onClick={() => { void install() }}>{prompt === null ? t('installUnavailable') : t('installButton')}</Button>}
          </SettingsRow>
          <SettingsRow title={t('swTitle')} description={t('swDescription')}>
            <span>{sw === 'active' ? t('swActive') : sw === 'unsupported' ? t('swUnsupported') : t('swInactive')}</span>
          </SettingsRow>
          <SettingsRow title={t('shareTitle')} description={t('shareDescription')} />
        </Card>
      </Section>
      <Section title={t('sectionNotify')}>
        <Card>
          <SettingsRow title={t('notifyTitle')} description={t('notifyDescription')}>
            <span role="status" data-testid="push-status">{busy ? t('notifyBusy') : status}</span>
            {canToggle && (subscribed === true
              ? <Button variant="outline" disabled={busy} onClick={() => { void run(async () => { await disablePush(); setSubscribed(false) }) }}>{t('notifyDisable')}</Button>
              : <Button variant="primary" disabled={busy} onClick={() => { void run(async () => { await enablePush(deviceName()); setSubscribed(true) }) }}>{t('notifyEnable')}</Button>)}
          </SettingsRow>
          <SettingsRow title={t('notifyTestTitle')} description={t('notifyTestDescription')}>
            <Button variant="outline" disabled={busy || subscribed !== true} onClick={() => { void run(sendTest, t('notifyTestSent')) }}>{t('notifyTestButton')}</Button>
          </SettingsRow>
          {notice !== null && <SettingsRow title={notice.error ? t('notifyErrorTitle') : t('notifyTestTitle')} description={notice.text} />}
        </Card>
      </Section>
    </Page>
  )
}

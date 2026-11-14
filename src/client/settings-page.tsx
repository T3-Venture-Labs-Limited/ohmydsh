// Settings page (lazy chunk): install state, service worker state, links, notification permission.
import { useEffect, useState } from 'react'
import { Button, Card, Page, Section, SettingsRow } from '../kit/index.ts'
import type { T } from './locale.ts'

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export default function SettingsPage({ t }: { t: T }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches)
  const [sw, setSw] = useState<'checking' | 'active' | 'inactive' | 'unsupported'>('checking')
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => ('Notification' in window ? Notification.permission : 'unsupported'))

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

  const secure = window.isSecureContext
  const install = async (): Promise<void> => {
    if (prompt === null) return
    await prompt.prompt()
    await prompt.userChoice
    setPrompt(null)
  }
  const askPermission = async (): Promise<void> => { setPermission(await Notification.requestPermission()) }

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
        </Card>
      </Section>
      <Section title={t('sectionPhone')}>
        <Card>
          <SettingsRow title={t('openTitle')} description={t('openDescription')}>
            <Button variant="outline" onClick={() => { window.open('/m', '_blank', 'noopener') }}>{t('openButton')}</Button>
          </SettingsRow>
          <SettingsRow title={t('shareTitle')} description={t('shareDescription')} />
        </Card>
      </Section>
      <Section title={t('sectionNotify')}>
        <Card>
          <SettingsRow title={t('notifyPermission')} description={t('notifyDescription')}>
            {permission === 'granted'
              ? <span>{t('notifyGranted')}</span>
              : permission === 'denied' || permission === 'unsupported'
                ? <span>{t('notifyDenied')}</span>
                : <Button variant="outline" onClick={() => { void askPermission() }}>{t('notifyEnable')}</Button>}
          </SettingsRow>
        </Card>
      </Section>
    </Page>
  )
}

// "Pair a phone": a one-time QR code + link, and the list of paired devices with Remove.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Card, Section, SettingsRow } from '../kit/index.ts'
import { encodeQr, qrPath } from '../qr/qr.ts'
import type { T } from './locale.ts'

interface Issued { expiresAt: number; origin: string; kind: string; secure: boolean; warnings: string[]; links: { app: string; web: string } }
interface Device { id: string; name: string; createdAt: number; lastSeen: number }

async function api<R>(path: string, body?: unknown): Promise<R> {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const parsed = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & R
  if (!response.ok || parsed.ok === false) throw new Error(parsed.error ?? `request failed (${response.status})`)
  return parsed
}

export function QrImage({ text, label }: { text: string; label: string }) {
  const code = useMemo(() => qrPath(encodeQr(text)), [text])
  return (
    <svg role="img" aria-label={label} viewBox={code.viewBox} width={216} height={216} shapeRendering="crispEdges" style={{ background: '#fff', borderRadius: 8, flex: 'none' }}> {/* artwork:ok: a QR code must be black on white to scan */}
      <path d={code.path} fill="#000" /> {/* artwork:ok */}
    </svg>
  )
}

export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function ago(at: number, now: number, t: T): string {
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return t('pairJustNow')
  if (minutes < 60) return t('pairMinutesAgo', { n: String(minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return t('pairHoursAgo', { n: String(hours) })
  return t('pairDaysAgo', { n: String(Math.floor(hours / 24)) })
}

export default function PairSection({ t }: { t: T }) {
  const [issued, setIssued] = useState<Issued | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const loadDevices = useCallback(async () => {
    try { setDevices((await api<{ devices: Device[] }>('/pair/devices')).devices) } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void loadDevices() }, [loadDevices])

  // One tick per second only while a code is on screen.
  useEffect(() => {
    if (issued === null) return undefined
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [issued])

  const remaining = issued === null ? 0 : issued.expiresAt - now
  const expired = issued !== null && remaining <= 0
  // Poll the device list (visibility-aware, slow) while a code is live, to show the new phone once it pairs.
  useEffect(() => {
    if (issued === null || expired) return undefined
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void loadDevices() }, 4000)
    return () => { clearInterval(timer) }
  }, [issued, expired, loadDevices])

  const make = async (): Promise<void> => {
    setBusy(true); setError(null); setCopied(false)
    try { const next = await api<Issued>('/pair/code', {}); setNow(Date.now()); setIssued(next) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(true); setError(null)
    try { await api('/pair/remove', { id }); await loadDevices() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const copy = async (): Promise<void> => {
    if (issued === null) return
    try { await navigator.clipboard.writeText(issued.links.web); setCopied(true) } catch { setError(t('pairCopyFailed')) }
  }

  return (
    <Section title={t('sectionPair')}>
      <Card>
        <SettingsRow title={t('pairTitle')} description={t('pairDescription')}>
          <Button variant="primary" disabled={busy} onClick={() => { void make() }}>{issued === null || expired ? t('pairMake') : t('pairNew')}</Button>
        </SettingsRow>
        {issued !== null && !expired && (
          <div className="dk-settings-row" data-testid="pair-code">
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <QrImage text={issued.links.app} label={t('pairQrLabel')} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220, flex: 1 }}>
                <span className="dk-settings-row__title">{t('pairScan')}</span>
                <span className="dk-settings-row__description">{t('pairValid', { time: formatRemaining(remaining) })}</span>
                <span className="dk-settings-row__description">{t('pairAddress', { origin: issued.origin })}</span>
                {issued.warnings.map((w) => <span key={w} className="dk-settings-row__description" role="note">{w}</span>)}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="outline" onClick={() => { void copy() }}>{copied ? t('pairCopied') : t('pairCopy')}</Button>
                </div>
                <input readOnly aria-label={t('pairLinkLabel')} value={issued.links.web} onFocus={(e) => { e.currentTarget.select() }} style={{ font: 'inherit', fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', width: '100%', boxSizing: 'border-box' }} />
              </div>
            </div>
          </div>
        )}
        {expired && <SettingsRow title={t('pairExpiredTitle')} description={t('pairExpired')} />}
        {error !== null && <SettingsRow title={t('pairErrorTitle')} description={error} />}
      </Card>
      <Card>
        {devices !== null && devices.length === 0 && <SettingsRow title={t('pairNoDevices')} description={t('pairNoDevicesHint')} />}
        {(devices ?? []).map((d) => (
          <SettingsRow key={d.id} title={d.name} description={t('pairDeviceMeta', { paired: ago(d.createdAt, now, t), seen: ago(d.lastSeen, now, t) })}>
            <Button variant="danger" disabled={busy} onClick={() => { void remove(d.id) }} aria-label={t('pairRemoveLabel', { name: d.name })}>{t('pairRemove')}</Button>
          </SettingsRow>
        ))}
      </Card>
    </Section>
  )
}

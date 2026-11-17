// Webhook card on the detail view: URL, auth scheme, a curl example for that scheme, the secret (in full only right
// after create / rotate, otherwise the hint) and Rotate secret.
import { useState } from 'react'
import { Button, Card, Modal, Section } from '../kit/index.ts'
import type { AutomationView, WebhookAuth } from '../shared/types.ts'
import type { T } from './locale.ts'
import { curlExample, webhookUrl } from './model.ts'
import { CodeLine } from './ui.tsx'

export function authLabel(t: T, auth: WebhookAuth): string {
  return auth === 'token' ? t('authToken') : auth === 'hmac-sha256' ? t('authHmac') : auth === 'standard-webhooks' ? t('authStandard') : t('authNone')
}

export function authHint(t: T, auth: WebhookAuth): string {
  return auth === 'token' ? t('authTokenHint') : auth === 'hmac-sha256' ? t('authHmacHint') : auth === 'standard-webhooks' ? t('authStandardHint') : t('authNoneHint')
}

export function WebhookCard({ t, automation, origin, secret, busy, onRotate }: {
  t: T
  automation: AutomationView
  origin: string
  /** The full secret, only right after create / rotate. */
  secret: string | undefined
  busy: boolean
  onRotate: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  if (automation.source.kind !== 'webhook') return null
  const auth = automation.source.auth
  const url = webhookUrl(automation, origin)
  return (
    <Section title={t('webhookTitle')}>
      <Card padded>
        <div className="tr-kv" data-testid="webhook-card">
          <span className="tr-kv__key">{t('webhookUrl')}</span>
          <div className="tr-kv__value">
            <CodeLine t={t} text={url} label={`${t('copy')}: ${t('webhookUrl')}`} />
            <span className="tr-hint">{t('webhookTailnet', { id: automation.id })}</span>
          </div>

          <span className="tr-kv__key">{t('webhookAuth')}</span>
          <div className="tr-kv__value">
            <span style={{ paddingTop: 6 }}>{authLabel(t, auth)}</span>
            <span className="tr-hint">{auth === 'standard-webhooks' ? t('webhookStandardNote') : auth === 'none' ? t('webhookNoneNote') : authHint(t, auth)}</span>
          </div>

          {auth !== 'none' && (
            <>
              <span className="tr-kv__key">{t('secretLabel')}</span>
              <div className="tr-kv__value" data-testid="secret">
                {secret !== undefined
                  ? (
                    <>
                      <CodeLine t={t} text={secret} fresh label={`${t('copy')}: ${t('secretLabel')}`} />
                      <span className="tr-hint" role="status" style={{ color: 'var(--dsw-alias-state-warn-primary)' }}>{t('secretFresh')}</span>
                    </>
                  )
                  : (
                    <>
                      <span className="tr-mono" style={{ paddingTop: 6 }}>{automation.secretHint ?? '—'}</span>
                      <span className="tr-hint">{t('secretHidden')}</span>
                    </>
                  )}
                <div className="tr-actions">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { setConfirm(true) }}>{t('rotate')}</Button>
                </div>
              </div>
            </>
          )}

          <span className="tr-kv__key">{t('webhookExample')}</span>
          <div className="tr-kv__value">
            <CodeLine t={t} text={curlExample(url, auth)} label={`${t('copy')}: ${t('webhookExample')}`} />
          </div>
        </div>
      </Card>
      <Modal
        open={confirm}
        onClose={() => { setConfirm(false) }}
        title={t('rotateTitle')}
        description={t('rotateDescription')}
        closeLabel={t('close')}
        footer={<>
          <Button onClick={() => { setConfirm(false) }}>{t('cancel')}</Button>
          <Button variant="danger" data-modal-autofocus disabled={busy} onClick={() => { setConfirm(false); void onRotate() }}>{t('rotateConfirm')}</Button>
        </>}
      />
    </Section>
  )
}

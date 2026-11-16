// Composio source fields: connected account (from dsh-composio), trigger type for that account's toolkit, and the
// instance id the host fills in on save. Falls back to a free-text slug when the account list is unavailable.
import { useEffect, useState } from 'react'
import { Select, TextField } from '../kit/index.ts'
import type { SelectOption } from '../kit/index.ts'
import { call, errorText } from './api.ts'
import type { T } from './locale.ts'

export interface ComposioAccounts {
  available: boolean
  toolkits: { slug: string; name: string; accounts: { id: string; label: string; status: string }[] }[]
  listener: { state: string; lastError: string | null } | null
  error?: string
}
export interface ComposioTriggerType { slug: string; name: string; description: string; instructions: string }

export interface ComposioFieldsProps {
  t: T
  slug: string
  accountId: string
  instanceId: string
  slugError?: string | undefined
  onChange: (patch: { slug?: string; connectedAccountId?: string; instanceId?: string }) => void
}

const OTHER = '\u0000other'

export function ComposioFields({ t, slug, accountId, instanceId, slugError, onChange }: ComposioFieldsProps) {
  const [accounts, setAccounts] = useState<ComposioAccounts | undefined>()
  const [accountsError, setAccountsError] = useState<string | undefined>()
  const [types, setTypes] = useState<ComposioTriggerType[] | undefined>()
  const [typesError, setTypesError] = useState<string | undefined>()
  const [manualSlug, setManualSlug] = useState(false)

  useEffect(() => {
    let live = true
    call<ComposioAccounts>('composioAccounts').then((a) => { if (live) { setAccounts(a); setAccountsError(undefined) } }).catch((e: unknown) => { if (live) setAccountsError(errorText(e)) })
    return () => { live = false }
  }, [])

  const toolkit = accounts?.toolkits.find((tk) => tk.accounts.some((a) => a.id === accountId))
  useEffect(() => {
    if (toolkit === undefined) { setTypes(undefined); return }
    let live = true
    setTypes(undefined); setTypesError(undefined)
    call<ComposioTriggerType[]>('composioTriggerTypes', { toolkit: toolkit.slug }).then((list) => { if (live) setTypes(list) }).catch((e: unknown) => { if (live) setTypesError(errorText(e)) })
    return () => { live = false }
  }, [toolkit?.slug]) // eslint-disable-line react-hooks/exhaustive-deps

  const accountOptions: SelectOption[] = [{ value: '', label: t('composioPickAccount') }]
  for (const tk of accounts?.toolkits ?? []) {
    for (const a of tk.accounts) accountOptions.push({ value: a.id, label: `${a.label}${a.status === 'ACTIVE' ? '' : ` (${a.status.toLowerCase()})`}`, group: tk.name })
  }
  if (accountId !== '' && !accountOptions.some((o) => o.value === accountId)) accountOptions.push({ value: accountId, label: accountId })

  const typeKnown = types?.some((ty) => ty.slug === slug) === true
  const typeOptions: SelectOption[] = [{ value: '', label: t('composioPickTrigger') }, ...(types ?? []).map((ty) => ({ value: ty.slug, label: ty.name === '' ? ty.slug : `${ty.name} (${ty.slug})` })), { value: OTHER, label: t('composioOtherSlug') }]
  const showSlugText = manualSlug || types === undefined || (slug !== '' && !typeKnown)
  const typeValue = showSlugText ? OTHER : slug
  const chosen = types?.find((ty) => ty.slug === slug)

  const listener = accounts?.listener
  const listenerWarning = accounts?.available === true && listener !== null && listener !== undefined && listener.state !== 'live'
    ? t('composioListenerDown', { state: listener.state }) : undefined

  return (
    <>
      {accountsError !== undefined && <span className="tr-error" role="alert">{accountsError}</span>}
      {accounts?.error !== undefined && <span className="tr-error" role="alert">{accounts.error}</span>}
      {listenerWarning !== undefined && <span className="tr-hint tr-hint--warn">{listenerWarning}</span>}
      <div className="tr-grid tr-grid--wide">
        <Select
          label={t('composioAccountLabel')} hint={t('composioAccountHint')} value={accountId} options={accountOptions}
          onChange={(v) => { onChange({ connectedAccountId: v, ...(v !== accountId ? { slug: '', instanceId: '' } : {}) }); setManualSlug(false) }}
        />
        <Select
          label={t('composioTriggerLabel')} value={typeValue} options={typeOptions}
          {...(typesError !== undefined ? { hint: typesError } : chosen?.description ? { hint: chosen.description } : toolkit === undefined ? { hint: t('composioTriggerNeedsAccount') } : {})}
          onChange={(v) => { if (v === OTHER) { setManualSlug(true) } else { setManualSlug(false); onChange({ slug: v, instanceId: '' }) } }}
        />
      </div>
      {showSlugText && (
        <div className="tr-grid tr-grid--wide">
          <TextField label={t('slugLabel')} hint={t('slugHint')} value={slug} onChange={(e) => { onChange({ slug: e.target.value.trim().toUpperCase() }) }} spellCheck={false} {...(slugError === undefined ? {} : { error: slugError })} />
        </div>
      )}
      {chosen?.instructions !== undefined && chosen.instructions !== '' && <span className="tr-hint">{chosen.instructions.slice(0, 400)}</span>}
      <span className="tr-hint">{instanceId === '' ? t('composioInstanceOnSave') : t('composioInstance', { id: instanceId })}</span>
    </>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, Select, TextField } from '../kit/index.ts'
import { ApiError, call, type SkillRow, type StateResult } from './api.ts'
import { NAME_RE, nameTaken } from './helpers.ts'
import type { T } from './locale.ts'

export function CreateModal({ open, t, rows, createRoots, workspace, onClose, onCreated }: {
  open: boolean
  t: T
  rows: readonly SkillRow[]
  createRoots: StateResult['createRoots']
  workspace?: string | undefined
  onClose: () => void
  onCreated: (name: string, path: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [target, setTarget] = useState('user-agents')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  useEffect(() => { if (open) { setName(''); setDescription(''); setTarget('user-agents'); setError(undefined) } }, [open])

  const options = useMemo(() => {
    const labels: Record<string, string> = {
      'user-agents': t('createLocationAgents'), 'user-dsh': t('createLocationDsh'),
      'project-agents': t('createLocationProjectAgents'), 'project-dsh': t('createLocationProjectDsh'),
    }
    return Object.keys(createRoots).map(k => ({ value: k, label: labels[k] ?? k }))
  }, [createRoots, t])

  const nameError = name.length === 0 ? undefined : !NAME_RE.test(name) || name.length > 64 ? t('nameInvalid') : nameTaken(rows, name) ? t('nameTaken') : undefined
  const canCreate = name.length > 0 && description.trim().length > 0 && nameError === undefined && !busy

  const create = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      const r = await call<{ path: string }>('create', { name, description, target, ...(workspace === undefined ? {} : { workspace }) })
      onCreated(name, r.path)
    } catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('createTitle')} description={t('createDescription')} closeLabel={t('close')}
      footer={<>
        <Button onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" disabled={!canCreate} onClick={() => { void create() }}>{busy ? t('creating') : t('createAction')}</Button>
      </>}>
      <div className="ss-form">
        <TextField label={t('createName')} hint={t('createNameHint')} value={name} data-modal-autofocus autoComplete="off" spellCheck={false}
          onChange={(e) => { setName(e.target.value.trim()) }} {...(nameError === undefined ? {} : { error: nameError })} />
        <div>
          <label className="ss-label" htmlFor="ss-create-desc">{t('createSkillDescription')}</label>
          <textarea id="ss-create-desc" className="ss-textarea" value={description} onChange={(e) => { setDescription(e.target.value) }} />
          <p className="ss-note">{t('createSkillDescriptionHint')}</p>
        </div>
        <Select label={t('createLocation')} value={target} options={options} onChange={setTarget} />
        {error !== undefined && <div className="ss-banner" data-tone="error" role="alert">{error}</div>}
      </div>
    </Modal>
  )
}

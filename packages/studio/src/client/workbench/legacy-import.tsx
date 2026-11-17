// One-time "Import from Image Studio": reads the old dsh-image-gen IndexedDB gallery in the browser and sends the
// stored fields (no image bytes) to the host, which reads the files itself. Idempotent and resumable.
import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '../../kit/index.js'
import { BASE } from './api.js'
import { t } from './i18n.js'
import { errorText } from './ui.js'

const OLD_DB = 'dsh_image_gen_db'
const CHUNK = 25

interface Totals { imported: number; skipped: number; missing: number; failed: number; promptsImported: number; vaultImported: number }
interface Status { vaultFiles: number; importedItems: number }

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(BASE + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(json.message ?? json.error ?? `Request failed (${String(response.status)})`)
  return json
}

/** Read every record of one store; resolves [] when the database or store does not exist (and does not create it). */
function readStore(name: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve([]); return }
    const open = indexedDB.open(OLD_DB)
    let created = false
    open.onupgradeneeded = () => { created = true }
    open.onerror = () => { reject(open.error ?? new Error('Could not open the old gallery database')) }
    open.onsuccess = () => {
      const db = open.result
      if (created || !db.objectStoreNames.contains(name)) {
        db.close()
        if (created) indexedDB.deleteDatabase(OLD_DB) // never leave an empty database behind
        resolve([]); return
      }
      const request = db.transaction(name, 'readonly').objectStore(name).getAll()
      request.onsuccess = () => { db.close(); resolve(request.result as Record<string, unknown>[]) }
      request.onerror = () => { db.close(); reject(request.error ?? new Error('Could not read the old gallery')) }
    }
  })
}

const FIELDS = ['id', 'attachment', 'prompt', 'provider', 'model', 'createdAt', 'isFavorite', 'tags', 'workspacePath', 'sessionId', 'sourceAttachmentIds', 'original', 'seed', 'aspectRatio', 'imageSize', 'resolution', 'generationQuality', 'output'] as const
const pick = (record: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(FIELDS.filter(f => record[f] !== undefined).map(f => [f, record[f]]))

export function LegacyImport({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status | undefined>()
  const [oldCount, setOldCount] = useState<number | undefined>()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | undefined>()
  const [totals, setTotals] = useState<Totals | undefined>()
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(() => {
    void fetch(`${BASE}/import-legacy/status`, { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : undefined)).then((s: Status | undefined) => { setStatus(s) }, () => undefined)
    void readStore('gallery_history').then(rows => { setOldCount(rows.length) }, () => { setOldCount(0) })
  }, [])
  useEffect(() => { if (open) refresh() }, [open, refresh])

  const run = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    const sum: Totals = { imported: 0, skipped: 0, missing: 0, failed: 0, promptsImported: 0, vaultImported: 0 }
    try {
      const records = (await readStore('gallery_history')).map(pick).filter(r => typeof r.id === 'string')
      const prompts = (await readStore('favorite_prompts')).filter(p => typeof p.id === 'string' && typeof p.text === 'string').map(p => ({ id: p.id, text: p.text, ...(typeof p.addedAt === 'number' ? { addedAt: p.addedAt } : {}) }))
      const total = records.length
      for (let i = 0; i < Math.max(1, Math.ceil(total / CHUNK)); i++) {
        const items = records.slice(i * CHUNK, (i + 1) * CHUNK)
        setProgress({ done: i * CHUNK, total, phase: 'Gallery records' })
        const result = await post<{ items: { status: 'imported' | 'skipped' | 'missing' | 'failed' }[]; prompts?: { imported: number } }>('/import-legacy', { items, ...(i === 0 && prompts.length > 0 ? { prompts } : {}) })
        for (const item of result.items) sum[item.status]++
        sum.promptsImported += result.prompts?.imported ?? 0
      }
      setProgress({ done: total, total, phase: 'Original files' })
      for (let guard = 0; guard < 500; guard++) {
        const result = await post<{ imported: number; skipped: number; remaining: number }>('/import-legacy/vault', { limit: 100 })
        sum.vaultImported += result.imported
        if (result.remaining <= 0) break
      }
      setTotals(sum); onDone(); refresh()
    } catch (e) { setError(errorText(e)); setTotals(sum) } finally { setBusy(false); setProgress(undefined) }
  }

  const left = (status?.vaultFiles ?? 0) + Math.max(0, (oldCount ?? 0) - (status?.importedItems ?? 0))
  return (<>
    <button type="button" className="st-link" onClick={() => { setOpen(true) }}>{t('legacyImport')}</button>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false) }} title={t('legacyImport')} closeLabel={t('close')} description={t('legacyHint')}
      footer={<><Button onClick={() => { setOpen(false) }} disabled={busy}>{t('close')}</Button><Button variant="primary" onClick={() => { void run() }} disabled={busy}>{busy ? t('importing') : t('legacyRun')}</Button></>}>
      <div className="st-col" style={{ gap: 10 }}>
        <p className="st-muted" style={{ margin: 0 }}>{oldCount === undefined ? t('loading') : t('legacyFound', { n: oldCount, left: Math.max(0, left) })}</p>
        {progress !== undefined && (<div className="st-col" style={{ gap: 4 }}><div className="st-bar"><span style={{ width: `${String(progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100))}%` }} /></div><span className="st-small st-dim">{progress.phase} · {progress.done}/{progress.total}</span></div>)}
        {error !== undefined && <p className="st-error" role="alert">{error}</p>}
        {totals !== undefined && <p className="st-small" role="status">{t('legacySummary', { imported: totals.imported + totals.vaultImported, skipped: totals.skipped, missing: totals.missing })}{totals.failed > 0 ? ` · ${String(totals.failed)} failed` : ''}</p>}
      </div>
    </Modal>
  </>)
}

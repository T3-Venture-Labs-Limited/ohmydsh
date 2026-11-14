// Reference tray: per-slot asset inputs with gallery picker, upload, drop, and paste.
import { useRef, useState } from 'react'
import { Button, Modal } from '../../kit/index.js'
import { api, thumbUrl } from './api.js'
import { GalleryPicker } from './picker.js'
import { t } from './i18n.js'
import { IconClose } from '../../kit/icons.js'
import { IconPlus } from './icons.js'
import { errorText } from './ui.js'
import { cacheAssets } from './gallery-data.js'
import type { TraySlot } from './caps.js'
import type { AssetRecord } from './types.js'

const DRAG_MIME = 'application/x-studio-asset'
export function startAssetDrag(event: React.DragEvent, id: string): void { event.dataTransfer.setData(DRAG_MIME, id); event.dataTransfer.effectAllowed = 'copy' }

export function TraySlotView({ slot, assets, max, onChange, onError }: {
  slot: TraySlot; assets: AssetRecord[]; max: number; onChange: (next: AssetRecord[]) => void; onError: (message: string) => void
}) {
  const [picking, setPicking] = useState(false)
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const add = (incoming: AssetRecord[]): void => {
    const ok = incoming.filter(a => a.kind === slot.accepts && !assets.some(x => x.id === a.id))
    if (ok.length === 0) return
    cacheAssets(ok)
    onChange(slot.multiple ? [...assets, ...ok].slice(0, max) : [ok[0]!])
  }
  const upload = async (files: File[]): Promise<void> => {
    const usable = files.filter(f => f.type.startsWith(`${slot.accepts}/`)).slice(0, Math.max(1, max - assets.length))
    if (usable.length === 0) return
    setBusy(true)
    try { const made: AssetRecord[] = []; for (const f of usable) made.push(await api.importFile(f, { title: f.name.replace(/\.[^.]+$/, '') })); add(made) }
    catch (error) { onError(errorText(error)) } finally { setBusy(false) }
  }
  const full = slot.multiple ? assets.length >= max : assets.length >= 1

  return (
    <div className="st-col" style={{ gap: 6 }}
      onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length > 0) { e.preventDefault(); void upload(files) } }}>
      <div className="st-row"><span className="dk-field__label">{t(slot.labelKey)}{slot.required ? ' *' : ''}</span>{slot.multiple && <span className="st-dim st-small">{t('maxN', { n: max })}</span>}</div>
      <div className="st-tray">
        {assets.map(asset => (
          <div key={asset.id} className="st-slot">
            <img src={thumbUrl(asset.id, 128)} alt={asset.title ?? asset.prompt ?? asset.id} />
            <button type="button" className="st-slot__x" aria-label={t('remove')} onClick={() => { onChange(assets.filter(a => a.id !== asset.id)) }}><IconClose size={10} /></button>
          </div>
        ))}
        {!full && (
          <button type="button" className="st-slot st-slot--add" data-over={over} disabled={busy} title={t('dropHere')}
            onClick={() => { setPicking(true) }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); setOver(true) } }}
            onDragLeave={() => { setOver(false) }}
            onDrop={(e) => {
              e.preventDefault(); setOver(false)
              const id = e.dataTransfer.getData(DRAG_MIME)
              if (id !== '') void api.asset(id).then(r => { add([r.asset]) }, () => undefined)
              else if (e.dataTransfer.files.length > 0) void upload([...e.dataTransfer.files])
            }}>
            <span className="st-col" style={{ alignItems: 'center', gap: 2 }}><IconPlus size={16} />{busy ? '…' : t('pickAsset').split(' ')[0]}</span>
          </button>
        )}
      </div>
      <input ref={file} type="file" accept={`${slot.accepts}/*`} multiple={slot.multiple} className="st-sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { if (e.target.files !== null) void upload([...e.target.files]); e.target.value = '' }} />
      <Modal open={picking} onClose={() => { setPicking(false) }} title={t('pickAsset')} closeLabel={t('close')}
        footer={<Button size="sm" onClick={() => { file.current?.click() }}>{t('uploadFile')}</Button>}>
        <GalleryPicker kind={slot.accepts} multiple={slot.multiple && max - assets.length > 1} onPick={(picked) => { add(picked); setPicking(false) }} />
      </Modal>
    </div>
  )
}

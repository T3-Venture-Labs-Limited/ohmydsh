import { useState } from 'react'
import { Button, TextField } from '../../kit/index.js'
import { thumbUrl } from './api.js'
import { useGalleryData } from './gallery-data.js'
import { t } from './i18n.js'
import { IconCheck } from './icons.js'
import type { AssetRecord, MediaKind } from './types.js'

export function GalleryPicker({ kind, multiple, onPick }: { kind: MediaKind; multiple: boolean; onPick: (assets: AssetRecord[]) => void }) {
  const [q, setQ] = useState('')
  const [chosen, setChosen] = useState<AssetRecord[]>([])
  const data = useGalleryData({ kind, ...(q.trim() === '' ? {} : { q: q.trim() }) })
  return (
    <div className="st-col" style={{ gap: 10, width: 'min(620px, calc(100vw - 80px))' }}>
      <TextField label={t('searchPrompts')} hideLabel placeholder={t('searchPrompts')} value={q} onChange={(e) => { setQ(e.target.value) }} type="search" data-modal-autofocus />
      <div className="st-picker">
        {data.items.map(asset => {
          const on = chosen.some(c => c.id === asset.id)
          return (
            <button key={asset.id} type="button" className="st-tile" data-selected={on} aria-label={asset.title ?? asset.prompt ?? asset.id}
              onClick={() => { if (multiple) setChosen(prev => (on ? prev.filter(c => c.id !== asset.id) : [...prev, asset])); else onPick([asset]) }}>
              <img src={thumbUrl(asset.id, 160)} alt="" loading="lazy" />
              {on && <span className="st-tile__check" aria-hidden="true" style={{ opacity: 1, background: 'var(--dsw-alias-brand-primary)' }}><IconCheck size={14} /></span>}
            </button>
          )
        })}
        {data.items.length === 0 && !data.loading && <p className="st-muted" style={{ gridColumn: '1 / -1' }}>{t('emptyGallery')}</p>}
      </div>
      {data.hasMore && <Button size="sm" onClick={data.more}>{t('loadMore')}</Button>}
      {multiple && <Button variant="primary" size="sm" disabled={chosen.length === 0} onClick={() => { onPick(chosen) }}>{t('selectedN', { n: chosen.length })}</Button>}
    </div>
  )
}

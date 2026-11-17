import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconButton } from '../../kit/index.js'
import { IconCheck, IconCopy, IconFilm, IconImage, IconPlay, IconStar } from './icons.js'
import { posterUrl, thumbUrl, fileUrl } from './api.js'
import { duration } from './format.js'
import { t } from './i18n.js'
import type { AssetRecord } from './types.js'

export function useCopy(): { copied: string | undefined; copy: (text: string, id?: string) => void } {
  const [copied, setCopied] = useState<string | undefined>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
  const copy = useCallback((text: string, id = 'default') => {
    const done = (): void => { setCopied(id); if (timer.current !== undefined) clearTimeout(timer.current); timer.current = setTimeout(() => { setCopied(undefined) }, 1400) }
    if (navigator.clipboard !== undefined) void navigator.clipboard.writeText(text).then(done, () => { fallbackCopy(text); done() })
    else { fallbackCopy(text); done() }
  }, [])
  return { copied, copy }
}
function fallbackCopy(text: string): void {
  const area = document.createElement('textarea')
  area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'
  document.body.appendChild(area); area.select()
  try { document.execCommand('copy') } catch { /* ignore */ }
  area.remove()
}

export function CopyButton({ text, label = t('copy'), id }: { text: string; label?: string; id?: string }) {
  const { copied, copy } = useCopy()
  const isCopied = copied !== undefined
  return <IconButton label={isCopied ? t('copied') : label} title={isCopied ? t('copied') : label} icon={isCopied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={() => { copy(text, id) }} />
}

/** Poster/thumbnail of an asset. Videos play muted on hover when `hoverPlay` is set. */
export function MediaThumb({ asset, w = 320, hoverPlay = false, alt }: { asset: AssetRecord; w?: number; hoverPlay?: boolean; alt?: string }) {
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  const video = asset.kind === 'video'
  const src = video ? posterUrl(asset.id) : thumbUrl(asset.id, w)
  return (
    <span
      style={{ display: 'contents' }}
      onMouseEnter={hoverPlay && video ? () => { setPlaying(true) } : undefined}
      onMouseLeave={hoverPlay && video ? () => { setPlaying(false) } : undefined}
    >
      {failed
        ? <span className="st-tile__job">{video ? <IconFilm size={20} /> : <IconImage size={20} />}</span>
        : <img src={src} alt={alt ?? asset.title ?? asset.prompt ?? asset.id} loading="lazy" decoding="async" onError={() => { setFailed(true) }} draggable={false} />}
      {playing && <video src={fileUrl(asset.id)} muted loop autoPlay playsInline preload="none" style={{ position: 'absolute', inset: 0 }} />}
    </span>
  )
}

export function KindBadge({ asset }: { asset: AssetRecord }) {
  return asset.kind === 'video'
    ? <span className="st-tile__kind"><IconPlay size={10} />{duration(asset.durationMs)}</span>
    : null
}

export function StarToggle({ on, onToggle, className = 'st-tile__fav' }: { on: boolean; onToggle: () => void; className?: string }) {
  return (
    <button type="button" className={className} aria-pressed={on} aria-label={on ? t('removeFavorite') : t('addFavorite')} title={on ? t('removeFavorite') : t('addFavorite')}
      onClick={(event) => { event.stopPropagation(); onToggle() }}>
      <IconStar size={14} filled={on} />
    </button>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="dk-field"><span className="dk-field__label">{label}</span>{children}</div>
}

export function Toasts({ items }: { items: { id: number; message: string; tone: 'ok' | 'err' }[] }) {
  if (items.length === 0) return null
  return (
    <div role="status" aria-live="polite" style={{ position: 'absolute', left: 12, right: 12, bottom: 12, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 20, pointerEvents: 'none' }}>
      {items.map(item => (
        <div key={item.id} style={{ padding: '8px 12px', borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-toast-bg)', color: 'var(--dsw-alias-toast-label)', boxShadow: 'var(--dsw-elevation-soft)', borderLeft: `3px solid ${item.tone === 'err' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)'}` }}>
          {item.message}
        </div>
      ))}
    </div>
  )
}

export function errorText(error: unknown): string { return error instanceof Error ? error.message : t('unknownError') }

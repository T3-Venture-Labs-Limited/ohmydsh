// Small presentational pieces shared by the tabs: status badge, toolkit logo with letter fallback.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { avatarLetter } from '../shared/connections.ts'
import type { Tone } from '../shared/connections.ts'

export function Badge({ tone, children, large = false, dot = false }: { tone: Tone; children: ReactNode; large?: boolean; dot?: boolean }) {
  return <span className={large ? 'co-badge co-badge--lg' : 'co-badge'} data-tone={tone}>{dot && <span className="co-badge__dot" aria-hidden="true" />}{children}</span>
}

/**
 * Toolkit logo. A plain <img> to the public logo URL: no credentials, no referrer, lazy. If it is missing or fails to
 * load, a letter avatar drawn from theme tokens takes its place.
 */
export function Logo({ name, src, small = false }: { name: string; src?: string | null | undefined; small?: boolean }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  const show = typeof src === 'string' && src !== '' && !failed
  return (
    <span className={small ? 'co-logo co-logo--sm' : 'co-logo'} aria-hidden="true">
      {show ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} onError={() => { setFailed(true) }} /> : avatarLetter(name)}
    </span>
  )
}

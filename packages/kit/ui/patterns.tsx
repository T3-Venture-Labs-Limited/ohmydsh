// Page patterns matching the host Settings and Plugin Manager look: Page > Section > Card > SettingsRow.
import type { ReactNode } from 'react'
import { cx } from './cx.ts'
import { useKitStyles } from './styles.ts'
import { IconInbox, IconWarning } from './icons.tsx'

/** Root of a plugin page. Injects the kit stylesheet while mounted. */
export function Page({ title, description, children, className }: { title: string; description?: string; children?: ReactNode; className?: string }) {
  useKitStyles()
  return (
    <div className={cx('dk-page', className)}>
      <header>
        <h1 className="dk-page__title">{title}</h1>
        {description !== undefined && <p className="dk-page__description">{description}</p>}
      </header>
      {children}
    </div>
  )
}

/** A titled group of cards. */
export function Section({ title, description, children }: { title?: string; description?: string; children?: ReactNode }) {
  return (
    <section className="dk-section">
      {title !== undefined && <h2 className="dk-section__title">{title}</h2>}
      {description !== undefined && <p className="dk-section__description">{description}</p>}
      {children}
    </section>
  )
}

/** Settings card surface (`--dsw-alias-settings-card-fill/stroke`). Put SettingsRow children inside, or set `padded` for free content. */
export function Card({ children, padded = false, className }: { children?: ReactNode; padded?: boolean; className?: string }) {
  return <div className={cx('dk-card', padded && 'dk-card--padded', className)}>{children}</div>
}

/** Title + description on the left, control right-aligned; wraps below 768px. */
export function SettingsRow({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="dk-settings-row">
      <div className="dk-settings-row__text">
        <span className="dk-settings-row__title">{title}</span>
        {description !== undefined && <span className="dk-settings-row__description">{description}</span>}
      </div>
      {children !== undefined && <div className="dk-settings-row__control">{children}</div>}
    </div>
  )
}

/** Empty / error placeholder with optional actions. */
export function EmptyState({ title, description, icon, tone = 'neutral', actions }: {
  title: string
  description?: string
  icon?: ReactNode
  tone?: 'neutral' | 'error'
  actions?: ReactNode
}) {
  useKitStyles()
  return (
    <div className="dk-empty" data-tone={tone}>
      <span className="dk-empty__icon">{icon ?? (tone === 'error' ? <IconWarning size={24} /> : <IconInbox size={24} />)}</span>
      <p className="dk-empty__title">{title}</p>
      {description !== undefined && <p className="dk-empty__description">{description}</p>}
      {actions !== undefined && <div className="dk-empty__actions">{actions}</div>}
    </div>
  )
}

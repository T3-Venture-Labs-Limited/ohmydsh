import { Switch } from '../kit/index.ts'
import type { SkillRow } from './api.ts'
import { isDisabled, relativeTime, sourceLabel } from './helpers.ts'
import type { T } from './locale.ts'

export function Badge({ children, tone }: { children: string; tone?: 'error' | 'warn' | 'info' }) {
  return <span className="ss-badge" {...(tone === undefined ? {} : { 'data-tone': tone })}>{children}</span>
}

export function SkillListRow({ row, t, selected, busy, workspaceScoped, onSelect, onToggle }: {
  row: SkillRow
  t: T
  selected: boolean
  busy: boolean
  workspaceScoped: boolean
  onSelect: () => void
  onToggle: (hide: boolean) => void
}) {
  const disabled = isDisabled(row)
  const usage = row.usage === undefined
    ? t('usageNone')
    : `${t('usageCount', { count: row.usage.count })} · ${t('usageWhen', { when: relativeTime(row.usage.lastUsed) })}`
  const toggleable = row.state === 'active'
  return (
    <div className="ss-row" role="option" aria-selected={selected} tabIndex={0} data-dim={disabled || row.state !== 'active'} data-testid="ss-row"
      onClick={onSelect}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect() } }}>
      <div className="ss-row__main">
        <div className="ss-row__top">
          <span className="ss-row__name">{row.name}</span>
          <Badge>{sourceLabel(t, row.source)}</Badge>
          {row.state === 'shadowed' && <Badge tone="warn">{t('stateShadowed')}</Badge>}
          {row.state === 'invalid' && <Badge tone="error">{t('stateInvalid')}</Badge>}
          {row.state === 'active' && row.errors === 0 && row.warnings > 0 && <Badge tone="warn">{`${String(row.warnings)} ⚠`}</Badge>}
          {disabled && <Badge tone="info">{row.disabled === 'disabled-workspace' ? t('badgeDisabledHere') : workspaceScoped ? t('badgeDisabledGlobal') : t('badgeDisabledGlobal')}</Badge>}
          {row.disabled === 'enabled-workspace' && <Badge tone="info">{t('badgeEnabledHere')}</Badge>}
          {!row.editable && row.state !== 'invalid' && <Badge>{t('badgeReadOnly')}</Badge>}
          {row.symlink && <Badge>{t('badgeSymlink')}</Badge>}
          {row.wouldLoad && !row.modelInvocable && <Badge>{t('badgeModelHidden')}</Badge>}
          {row.wouldLoad && !row.userInvocable && <Badge>{t('badgeUserHidden')}</Badge>}
        </div>
        <span className="ss-row__desc" title={row.description}>{row.description === '' ? '—' : row.description}</span>
        <span className="ss-row__meta">
          {row.state === 'shadowed' && row.shadowedBy !== undefined ? `${t('shadowedBy', { source: sourceLabel(t, row.shadowedBy.source) })} · ` : ''}
          {row.shadows > 0 ? `${t('shadowsOthers', { count: row.shadows })} · ` : ''}
          {usage}
        </span>
      </div>
      {toggleable && (
        <span className="ss-row__switch" onClick={(e) => { e.stopPropagation() }} onKeyDown={(e) => { e.stopPropagation() }}>
          <Switch checked={!disabled} disabled={busy} label={t('toggleLabel', { name: row.name })} title={t('toggleHint')} onChange={(next) => { onToggle(!next) }} />
        </span>
      )}
    </div>
  )
}

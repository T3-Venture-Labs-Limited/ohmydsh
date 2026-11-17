// Right-sidebar "Review" tab: every comment of this session, grouped by file, with edit / resolve / delete / jump / send.
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Button, EmptyState, IconButton, SegmentedControl } from '../../kit/index.ts'
import type { Ctx, InputActionsLike } from '../host.ts'
import type { CommentStore } from '../store.ts'
import type { ReviewComment } from '../types.ts'
import { groupComments, locationOf } from '../format.ts'
import { reveal } from '../reveal.ts'
import { t } from '../locale.ts'
import { doSend } from './Dock.tsx'
import { IconCheck, IconEdit, IconJump, IconSend, IconTrash, IconUndo } from './icons.tsx'
import { useDrcStyles } from './styles.ts'
import { syncStatus } from '../hostSync.ts'

type Filter = 'open' | 'sent' | 'resolved' | 'all'
const STATUS_KEY = { open: 'statusOpen', sent: 'statusSent', resolved: 'statusResolved' } as const
const statusLabel = (item: ReviewComment): string => item.status === 'resolved' && item.resolvedBy === 'agent' ? t('statusResolvedByAgent') : t(STATUS_KEY[item.status])

function Item({ item, store, ctx, input }: { item: ReviewComment; store: CommentStore; ctx: Ctx; input: InputActionsLike | undefined }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.body)
  const saveEdit = (): void => { store.update(item.sessionId, item.id, { body: draft.trim() }); setEditing(false) }
  const quote = item.quote.length > 220 ? `${item.quote.slice(0, 220)}…` : item.quote
  return (
    <li className="drc-item" data-status={item.status} style={{ listStyle: 'none' }}>
      <div className="drc-item__row">
        <span className="drc-item__meta">
          <span className="drc-item__number">RC-{item.number}</span>
          <span>{locationOf(item)}</span>
          <span className="drc-badge" data-status={item.status} data-by={item.resolvedBy}>{statusLabel(item)}</span>
        </span>
        <span className="drc-item__actions">
          <IconButton label={t('jump')} icon={<IconJump />} onClick={() => { void reveal(ctx, item) }} />
          {item.status === 'open' && <IconButton label={t('sendOne')} icon={<IconSend />} onClick={() => { doSend(store, item.sessionId, input, [item.id]) }} />}
          <IconButton label={editing ? t('saveEdit') : t('edit')} icon={editing ? <IconCheck /> : <IconEdit />}
            onClick={() => { if (editing) saveEdit(); else { setDraft(item.body); setEditing(true) } }} />
          <IconButton label={item.status === 'resolved' ? t('reopen') : t('resolve')} icon={item.status === 'resolved' ? <IconUndo /> : <IconCheck />}
            onClick={() => { store.setStatus(item.sessionId, [item.id], item.status === 'resolved' ? 'open' : 'resolved') }} />
          <IconButton label={t('delete')} icon={<IconTrash />} onClick={() => { store.remove(item.sessionId, item.id) }} />
        </span>
      </div>
      <blockquote className="drc-quote">{quote}</blockquote>
      {editing
        ? <textarea className="drc-textarea" aria-label={t('edit')} value={draft} autoFocus
            onChange={event => { setDraft(event.target.value) }}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.key === 'Escape') setEditing(false)
              else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); saveEdit() }
            }} />
        : <p className="drc-item__body" data-empty={item.body === '' || undefined}>{item.body === '' ? t('noBody') : item.body}</p>}
      {item.resolution !== undefined && item.resolution !== '' && <p className="drc-item__note"><span>{t('agentNote')}</span> {item.resolution}</p>}
    </li>
  )
}

export function createReviewTab(ctx: Ctx, store: CommentStore) {
  return function ReviewTab(props: { sessionId?: string; inputActions?: InputActionsLike }) {
    useDrcStyles()
    useSyncExternalStore(store.subscribe, store.getSnapshot)
    useSyncExternalStore(syncStatus.subscribe, syncStatus.getSnapshot)
    const [filter, setFilter] = useState<Filter>('open')
    const sessionId = props.sessionId ?? ''
    const all = store.list(sessionId)
    const shown = useMemo(() => all.filter(item => filter === 'all' || item.status === filter), [all, filter])
    const groups = useMemo(() => groupComments(shown), [shown])
    const openCount = all.filter(item => item.status === 'open').length
    return (
      <div className="drc-tab" data-drc-ui>
        <div className="drc-tab__head">
          <SegmentedControl id="drc-filter" label={t('filterLabel')} value={filter} onChange={setFilter}
            options={[{ value: 'open', label: t('filterOpen') }, { value: 'sent', label: t('filterSent') }, { value: 'resolved', label: t('filterResolved') }, { value: 'all', label: t('filterAll') }]} />
        </div>
        {syncStatus.isFull(sessionId) && <p className="drc-tab__warn" role="status">{t('hostFull')}</p>}
        <div className="drc-tab__scroll">
          {groups.length === 0
            ? (all.length === 0
              ? <EmptyState title={t('emptyTitle')} description={t('emptyBody')} />
              : <EmptyState title={t('emptyFilteredTitle')} description={t('emptyFilteredBody')} />)
            : groups.map(group => (
              <section key={group.key} className="drc-group">
                <h3 className="drc-group__title">{group.key === 'chat' ? t('groupChat') : group.title}</h3>
                <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {group.items.map(item => <Item key={item.id} item={item} store={store} ctx={ctx} input={props.inputActions} />)}
                </ul>
              </section>
            ))}
        </div>
        {openCount > 0 && (
          <div className="drc-tab__foot">
            <Button size="sm" variant="primary" icon={<IconSend />} onClick={() => { doSend(store, sessionId, props.inputActions) }}>{t('sendAllOpen', { n: openCount })}</Button>
            <IconButton label={t('clearAll')} icon={<IconTrash />} onClick={() => { store.removeWhere(sessionId, item => item.status === 'open') }} />
          </div>
        )}
      </div>
    )
  }
}

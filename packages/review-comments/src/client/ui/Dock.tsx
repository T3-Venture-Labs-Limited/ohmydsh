// conversation.input.dock entry: "N comments · Send to composer" above the composer card.
import { useSyncExternalStore } from 'react'
import { Button, IconButton } from '../../kit/index.ts'
import type { Ctx, InputActionsLike } from '../host.ts'
import { sidebarRightOf } from '../host.ts'
import type { CommentStore } from '../store.ts'
import { sendToComposer } from '../send.ts'
import { t } from '../locale.ts'
import { uiState } from '../ui-state.ts'
import { TAB_KIND } from '../constants.ts'
import { IconComment, IconSend, IconTrash } from './icons.tsx'
import { useDrcStyles } from './styles.ts'
import { syncStatus } from '../hostSync.ts'

export const TAB_OPEN_PARAMS = undefined

export function doSend(store: CommentStore, sessionId: string, input: InputActionsLike | undefined, ids?: readonly string[]): void {
  const open = store.list(sessionId).filter(item => item.status === 'open' && (ids === undefined || ids.includes(item.id)))
  if (open.length === 0) return
  if (input === undefined) { uiState.notify(t('sendUnavailable'), 'error'); return }
  const result = sendToComposer(store, sessionId, input, open)
  if (result.blocked) uiState.notify(t('sendBlocked', { n: result.inserted }), 'error')
  else uiState.notify(t('sentN', { n: result.inserted }))
}

export function createDock(ctx: Ctx, store: CommentStore) {
  return function ReviewDock(props: { sessionId?: string; inputActions?: InputActionsLike }) {
    useDrcStyles()
    useSyncExternalStore(store.subscribe, store.getSnapshot)
    useSyncExternalStore(syncStatus.subscribe, syncStatus.getSnapshot)
    const sessionId = props.sessionId ?? ''
    const open = store.list(sessionId).filter(item => item.status === 'open')
    if (sessionId === '' || open.length === 0) return null
    return (
      <div className="drc-dock" data-drc-ui>
        <span className="drc-chip">
          <span className="drc-chip__label"><IconComment />{open.length === 1 ? t('chipOne') : t('chipMany', { n: open.length })}</span>
          <Button size="sm" variant="primary" icon={<IconSend />} title={t('sendTitle')} onClick={() => { doSend(store, sessionId, props.inputActions) }}>{t('sendToComposer')}</Button>
          <IconButton label={t('openList')} icon={<IconComment />} onClick={() => { try { sidebarRightOf(ctx)?.openTab?.(TAB_KIND) } catch { /* sidebar not ready */ } }} />
          <IconButton label={t('clearAll')} icon={<IconTrash />} onClick={() => { store.removeWhere(sessionId, item => item.status === 'open') }} />
        </span>
        {syncStatus.isFull(sessionId) && <span className="drc-dock__note" role="status">{t('hostFull')}</span>}
        {store.memoryOnly(sessionId) && <span className="drc-dock__note" role="status">{t('storageMemory')}</span>}
      </div>
    )
  }
}

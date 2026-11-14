// Demo sidebar panel body (lazy chunk), shown in the central column when the panellist icon is selected.
import { Button, EmptyState, Page } from '../kit/index.ts'
import type { T } from './locale.ts'

export default function Panel({ t }: { t: T }) {
  return (
    <Page title={t('panel')}>
      <EmptyState
        title={t('panelEmptyTitle')}
        description={t('panelEmptyDescription')}
        actions={<Button variant="outline" size="sm" onClick={() => { document.querySelector<HTMLElement>('[data-shortcut-modal="settings"]')?.focus() }}>{t('panelAction')}</Button>}
      />
    </Page>
  )
}

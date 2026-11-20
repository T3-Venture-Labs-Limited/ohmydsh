// "Built on DeepSeek Harness": the truthful credit shown in Settings > General (below the version row).
import { HARNESS_URL } from '../shared/config.ts'
import type { T } from './locale.ts'

export function Attribution({ t }: { t: T }) {
  return (
    <div data-ohmydsh-attribution="" style={{ padding: '16px 0', fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' }}>
      <div>
        <strong>{t('productName')}</strong>
        {' · '}
        {t('builtOn')}
        {' '}
        <a href={HARNESS_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>{t('harnessName')}</a>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }}>{t('disclaimer')}</div>
    </div>
  )
}

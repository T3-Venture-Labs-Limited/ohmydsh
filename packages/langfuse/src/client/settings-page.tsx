// Settings page (lazy chunk): live status of the tracer. Configuration itself lives in the plugin row / env.
import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Page, Section, SettingsRow } from '../kit/index.ts'
import type { Face, TraceStatus } from './trace-link.ts'
import type { T } from './locale.ts'

export default function SettingsPage({ t, face }: { t: T; face: Face }) {
  const [state, setState] = useState<TraceStatus | null | undefined>(undefined)
  const load = useCallback(() => { setState(undefined); void face.status().then(setState) }, [face])
  useEffect(() => { load() }, [load])

  const label = state === undefined ? t('statusUnknown') : state === null ? t('statusUnreachable') : state.enabled ? t('statusOn') : t('statusOff')
  return (
    <Page title={t('pageTitle')} description={t('pageDescription')}>
      <Section title={t('sectionStatus')}>
        <Card>
          <SettingsRow title={t('statusTitle')} {...(state?.enabled === false && state.reason !== undefined ? { description: t('offReason', { reason: state.reason }) } : {})}>
            <span role="status">{label}</span>
            <Button variant="outline" onClick={load}>{t('recheck')}</Button>
          </SettingsRow>
          {state?.enabled === true && state.baseUrl !== undefined ? <SettingsRow title={t('serverTitle')}><span>{state.baseUrl}</span></SettingsRow> : null}
          {state?.enabled === true && state.environment !== undefined ? <SettingsRow title={t('environmentTitle')}><span>{state.environment}</span></SettingsRow> : null}
        </Card>
      </Section>
    </Page>
  )
}

// Settings page (lazy chunk). Only dsh-kit controls and --dsw-* tokens; text goes through `t`.
import { useSyncExternalStore } from 'react'
import { Card, Page, SegmentedControl, Section, Select, SettingsRow, Switch } from '../kit/index.ts'
import type { ThemeController } from './controller.ts'
import type { T } from './locale.ts'

type Source = 'stock' | 'omarchy' | 'palette'

const SWATCHES = ['background', 'lighter_background', 'foreground', 'accent', 'red', 'green', 'blue', 'magenta'] as const

export default function SettingsPage({ t, controller }: { t: T; controller: ThemeController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const source: Source = state.choice === 'stock' || state.choice === 'omarchy' ? state.choice : 'palette'
  const lastPalette = controller.palettes.some((p) => p.id === state.choice) ? state.choice : (controller.palettes[0]?.id ?? '')

  const pick = (next: Source): void => {
    if (next === 'palette') controller.setChoice(lastPalette)
    else controller.setChoice(next)
  }

  let status: string | undefined
  if (source === 'omarchy') {
    if (state.status === 'live' && state.omarchy !== undefined) {
      status = t('statusLive', { name: state.omarchy.name === '' ? 'Omarchy' : state.omarchy.name, mode: t(state.omarchy.mode === 'light' ? 'statusModeLight' : 'statusModeDark') })
    } else status = state.status === 'unavailable' ? t('statusUnavailable') : t('statusConnecting')
  }

  return (
    <Page title={t('pageTitle')} description={t('pageDescription')}>
      <Section title={t('sectionSource')}>
        <Card>
          <SettingsRow title={t('sourceTitle')} description={t('sourceDescription')}>
            <SegmentedControl
              id="dsh-theme-source"
              label={t('sourceLabel')}
              value={source}
              onChange={pick}
              options={[
                { value: 'stock', label: t('sourceStock') },
                { value: 'omarchy', label: t('sourceOmarchy') },
                { value: 'palette', label: t('sourcePalette') },
              ]}
            />
          </SettingsRow>
          {source === 'palette' && (
            <SettingsRow title={t('paletteTitle')} description={t('paletteDescription')}>
              <Select
                label={t('paletteLabel')}
                hideLabel
                value={state.choice}
                onChange={(id) => { controller.setChoice(id) }}
                options={controller.palettes.map((p) => ({ value: p.id, label: p.name }))}
              />
            </SettingsRow>
          )}
          {status !== undefined && (
            <SettingsRow title={t('statusTitle')} description={status} />
          )}
          {state.paused && <SettingsRow title={t('pausedTitle')} description={t('pausedDescription')} />}
          {state.applied !== undefined && (
            <SettingsRow title={t('previewLabel')}>
              <span role="img" aria-label={t('previewLabel')} style={{ display: 'inline-flex', gap: 4 }}>
                {SWATCHES.map((key) => (
                  <span
                    key={key}
                    style={{ width: 16, height: 16, borderRadius: 4, border: '0.5px solid var(--dsw-alias-border-l3)', background: state.applied?.colors[key] ?? 'transparent' }}
                  />
                ))}
              </span>
            </SettingsRow>
          )}
        </Card>
      </Section>
      {source !== 'stock' && (
        <Section title={t('sectionOptions')}>
          <Card>
            <SettingsRow title={t('semanticTitle')} description={t('semanticDescription')}>
              <Switch
                checked={state.semanticColors === 'omarchy'}
                onChange={(on) => { controller.setSemanticColors(on ? 'omarchy' : 'dsh') }}
                label={t('semanticLabel')}
              />
            </SettingsRow>
          </Card>
        </Section>
      )}
    </Page>
  )
}

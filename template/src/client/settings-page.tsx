// Demo settings page (lazy chunk). Only dsh-kit controls and --dsw-* tokens; text goes through `t`.
import { useState } from 'react'
import { Button, Card, IconButton, Modal, Page, SegmentedControl, Section, Select, SettingsRow, Switch, TextField, Tooltip } from '../kit/index.ts'
import type { T } from './locale.ts'

const DEFAULTS = { enabled: true, mode: 'comfortable' as const, model: 'balanced', name: 'My plugin' }
type Mode = 'compact' | 'comfortable' | 'spacious'

export default function SettingsPage({ t }: { t: T }) {
  const [enabled, setEnabled] = useState(DEFAULTS.enabled)
  const [mode, setMode] = useState<Mode>(DEFAULTS.mode)
  const [model, setModel] = useState(DEFAULTS.model)
  const [name, setName] = useState(DEFAULTS.name)
  const [confirm, setConfirm] = useState(false)

  const reset = (): void => {
    setEnabled(DEFAULTS.enabled); setMode(DEFAULTS.mode); setModel(DEFAULTS.model); setName(DEFAULTS.name); setConfirm(false)
  }

  return (
    <Page title={t('pageTitle')} description={t('pageDescription')}>
      <Section title={t('sectionGeneral')}>
        <Card>
          <SettingsRow title={t('enabledTitle')} description={t('enabledDescription')}>
            <Tooltip label={t('helpTooltip')} side="left">
              <IconButton label={t('help')} icon={<span aria-hidden="true">?</span>} />
            </Tooltip>
            <Switch checked={enabled} onChange={setEnabled} label={t('enabledTitle')} />
          </SettingsRow>
          <SettingsRow title={t('modeTitle')} description={t('modeDescription')}>
            <SegmentedControl
              id="mode"
              label={t('modeLabel')}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'compact', label: t('modeCompact') },
                { value: 'comfortable', label: t('modeComfortable') },
                { value: 'spacious', label: t('modeSpacious') },
              ]}
            />
          </SettingsRow>
          <SettingsRow title={t('modelTitle')}>
            <Select
              label={t('modelLabel')}
              hideLabel
              value={model}
              onChange={setModel}
              options={[{ value: 'fast', label: 'Fast' }, { value: 'balanced', label: 'Balanced' }, { value: 'thorough', label: 'Thorough' }]}
            />
          </SettingsRow>
        </Card>
        <Card padded>
          <TextField
            label={t('nameLabel')}
            hint={t('nameHint')}
            value={name}
            onChange={(event) => { setName(event.target.value) }}
            {...(name.trim().length < 3 ? { error: t('nameError') } : {})}
          />
        </Card>
      </Section>
      <Section title={t('sectionActions')}>
        <Card>
          <SettingsRow title={t('resetTitle')} description={t('resetDescription')}>
            <Button variant="outline" onClick={() => { setConfirm(true) }}>{t('resetButton')}</Button>
          </SettingsRow>
        </Card>
      </Section>
      <Modal
        open={confirm}
        onClose={() => { setConfirm(false) }}
        title={t('confirmTitle')}
        description={t('confirmDescription')}
        closeLabel={t('close')}
        footer={<>
          <Button onClick={() => { setConfirm(false) }}>{t('cancel')}</Button>
          <Button variant="primary" data-modal-autofocus onClick={reset}>{t('confirmAction')}</Button>
        </>}
      />
    </Page>
  )
}

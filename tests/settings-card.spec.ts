import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { ImageGenerationSettingsCard } from '../src/client/index.js'

// Exercise the actual rendered form handlers without a DOM dependency. Effects
// (host subscriptions and status polling) are outside this form-action harness.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, scopeEffects: [] as Array<() => unknown> }))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useEffect(setup: () => unknown, dependencies?: unknown[]) {
      const dependency = dependencies?.[0] as { getSnapshot?: unknown; set?: unknown; subscribe?: unknown } | undefined
      if (typeof dependency?.getSnapshot === 'function' && typeof dependency.set === 'function'
        && typeof dependency.subscribe === 'function') hooks.scopeEffects.push(setup)
    },
    useState(initial: unknown) {
      const index = hooks.cursor++
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
      return [hooks.values[index], (next: unknown) => {
        hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next
      }]
    },
  }
})

type Element = ReactElement<Record<string, any>>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node === null || typeof node === 'boolean' || node === undefined) return ''
  if (typeof node !== 'object') return String(node)
  return 'props' in node ? text((node as Element).props.children) : ''
}

function formHarness(lang = 'en', initialValue: Record<string, unknown> = { openaiCompatBaseURL: 'https://relay.example/v1' }, provider = 'openai-compat', state: { writable?: boolean; status?: 'loading' | 'ready' | 'unavailable'; mode?: 'host' | 'memory' } = {}) {
  let stored = { ...initialValue }
  const setKey = vi.fn(async () => ({ ok: true }))
  const setSetting = vi.fn(async (field: string, value: unknown): Promise<boolean | void> => {
    stored = { ...stored, [field]: value }
  })
  const props = {
    scope: {
      getSnapshot: () => ({ writable: true, value: stored, ...state }),
      subscribe: vi.fn(), set: setSetting,
    },
    credentials: { describe: vi.fn(), set: setKey },
    credentialsAvailable: () => true,
    locale: { getSnapshot: () => ({ active: lang }) },
  } as unknown as Parameters<typeof ImageGenerationSettingsCard>[0]
  const render = () => {
    hooks.cursor = 0
    return ImageGenerationSettingsCard(props)
  }
  const row = () => elements(render()).find(element => element.key === provider
    && element.props.className?.startsWith('dsh-st-provider-row'))!
  const find = (predicate: (element: Element) => boolean) => elements(row()).find(predicate)!
  const channelRow = () => elements(render()).find(element => element.props.className?.includes('dsh-st-compat-channel-row'))
  const findChannel = (predicate: (element: Element) => boolean) => elements(channelRow()).find(predicate)
  // The card renders open on the plugin's own page now, so only the provider
  // row still needs a click to expand.
  find(element => element.props.className === 'dsh-st-provider-head').props.onClick()
  return {
    setKey, setSetting,
    expand: () => find(element => element.props.className === 'dsh-st-provider-head').props.onClick(),
    cardText: () => text(render()),
    settingInput: (label: string) => {
      const field = elements(render()).find(element => element.type === 'label' && text(element).startsWith(label))!
      return elements(field).find(element => element.type === 'input')!
    },
    syncScope: () => { for (const setup of hooks.scopeEffects.splice(0)) setup() },
    rowText: () => text(row()),
    providerHeadChildren: () => elements(row()).find(element => element.props.className === 'dsh-st-provider-head-row')!.props.children as Element[],
    addChannel: () => elements(render()).find(element => element.props['aria-label'] === ('Add OpenAI-compatible channel'))!.props.onClick(),
    channelExists: () => channelRow() !== undefined,
    channelText: () => text(channelRow()),
    channelField: (label: string, value: string) => {
      const field = findChannel(element => element.type === 'label' && text(element).startsWith(label))!
      elements(field).find(element => ['input', 'textarea', 'select'].includes(String(element.type)))!.props.onChange({ target: { value } })
    },
    saveChannel: () => findChannel(element => element.type === 'form')!.props.onSubmit({ preventDefault() {} }),
    removeChannel: () => findChannel(element => element.type === 'button' && text(element) === ('Remove channel'))!.props.onClick(),
    typeURL: (value: string) => find(element => element.props.type === 'url').props.onChange({ target: { value } }),
    typeKey: (value: string) => find(element => element.props.type === 'password').props.onChange({ target: { value } }),
    keyValue: () => find(element => element.props.type === 'password').props.value,
    field: (label: string, value: string) => {
      const field = find(element => element.type === 'label' && text(element).startsWith(label))
      elements(field).find(element => ['input', 'textarea', 'select'].includes(String(element.type)))!.props.onChange({ target: { value } })
    },
    disabled: (label: string) => find(element => element.type === 'button' && text(element) === label).props.disabled,
    click: (label: string) => find(element => element.type === 'button' && text(element) === label).props.onClick(),
    save: () => find(element => element.type === 'form').props.onSubmit({ preventDefault() {} }),
  }
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.scopeEffects = [] })
afterEach(() => { vi.unstubAllGlobals() })

describe('settings card credential actions', () => {
  it.each(['en'])('saves and reopens the global cloud timeout in %s', async lang => {
    const form = formHarness(lang)
    const label = 'Cloud generation timeout (seconds)'
    expect(form.settingInput(label).props.value).toBe(150)
    expect(form.settingInput(label).props).toMatchObject({ min: '5', max: '3600', step: '1' })
    form.settingInput(label).props.onChange({ target: { value: '240' } })
    form.settingInput(label).props.onBlur()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('cloudTimeoutMs', 240_000))
    hooks.values = []
    expect(form.settingInput(label).props.value).toBe(240)
    expect(form.cardText()).toContain('Does not affect subscription channels or ComfyUI')
  })

  it('restores the saved cloud timeout when the host rejects the write', async () => {
    const form = formHarness('en', { cloudTimeoutMs: 240_000 })
    const label = 'Cloud generation timeout (seconds)'
    form.setSetting.mockRejectedValueOnce(new Error('timeout-write-rejected'))
    form.settingInput(label).props.onChange({ target: { value: '300' } })
    form.settingInput(label).props.onBlur()
    await vi.waitFor(() => expect(form.cardText()).toContain('timeout-write-rejected'))
    expect(form.settingInput(label).props.value).toBe(240)
  })

  it.each(['', '4', '3601', '5.5'].flatMap(value =>
    [undefined, 240_000].map(cloudTimeoutMs => ({ value, cloudTimeoutMs })),
  ))('restores the saved cloud timeout on blur for invalid input "$value" ($cloudTimeoutMs)', ({ value, cloudTimeoutMs }) => {
    const form = formHarness('en', { cloudTimeoutMs })
    const label = 'Cloud generation timeout (seconds)'
    form.settingInput(label).props.onChange({ target: { value } })
    form.settingInput(label).props.onBlur()
    expect(form.settingInput(label).props.value).toBe((cloudTimeoutMs ?? 150_000) / 1000)
    expect(form.setSetting).not.toHaveBeenCalled()
  })

  it.each(['zh', 'en'])('saves, reopens and clears the separate edit model with the SiliconFlow format in %s', async lang => {
    const form = formHarness(lang, { openaiCompatBaseURL: 'https://relay.example/v1', openaiCompatModel: 'generation-model' })
    const modelLabel = 'Editing model'
    const formatLabel = 'Edit request format'
    form.field(modelLabel, ' Qwen/Qwen-Image-Edit ')
    form.field(formatLabel, 'siliconflowJson')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('openaiCompatEditFormat', 'siliconflowJson'))
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatEditModel', 'Qwen/Qwen-Image-Edit')
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatModel', 'generation-model')
    hooks.values = []
    form.expand()
    expect(form.rowText()).toContain('Edit dimensions follow the reference')
    form.field(modelLabel, '')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('openaiCompatEditModel', ''))
  })

  it('automatically recognizes the official SiliconFlow endpoint while keeping reference instructions visible', () => {
    const form = formHarness('en', { openaiCompatBaseURL: 'https://api.siliconflow.cn/v1', openaiCompatModel: 'Qwen/Qwen-Image', openaiCompatEditModel: 'Qwen/Qwen-Image-Edit-2509' })
    expect(form.rowText()).toContain('Automatic: official JSON contract')
    expect(form.rowText()).toContain('Edit dimensions follow the reference; size and quality fields are omitted. Qwen-Image-Edit supports one reference, Edit-2509 up to three. The plugin fills the image fields.')
    expect(form.rowText()).toContain('Extra JSON fields')
  })

  it.each(['Fetch models', 'Test connection'])('requires saving a changed Google protocol before %s', action => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('en', {}, 'google')
    form.field('Request protocol', 'native')
    form.click(action)
    expect(form.rowText()).toContain('Save the request protocol before fetching models or testing the connection.')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['zh', 'en'])('saves and reopens the Google native protocol setting in %s', async lang => {
    const form = formHarness(lang, {}, 'google')
    form.field('Request protocol', 'native')
    form.typeURL('https://relay.example/v1beta')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('googleNative', true))
    expect(form.setSetting).toHaveBeenCalledWith('googleEndpoint', 'https://relay.example/v1beta')
    hooks.values = []
    form.expand()
    expect(form.rowText()).toContain('https://example.com/v1beta')
    form.field('Request protocol', 'interactions')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('googleNative', false))
  })

  it.each([
    { openaiCompatBaseURL: 'https://token.sensenova.cn/v1', openaiCompatModel: 'sensenova-u1.5-lite' },
    { openaiCompatBaseURL: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', openaiCompatModel: 'qwen-image-3.0' },
  ])('exposes JSON edit fields for a recognized official endpoint without a manual format switch', async config => {
    const form = formHarness('en', config)
    expect(form.rowText()).toContain('Automatic: official JSON contract')
    form.field('Extra JSON fields', '{"watermark":false,"prompt_extend":false}')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('openaiCompatEditExtra', { watermark: false, prompt_extend: false }))
  })
  it('saves independent resolution, quality and generation JSON fields', async () => {
    const form = formHarness()
    form.field('Custom resolution table (JSON)', '{"16:9":{"2K":"2048x1152"}}')
    form.field('Default generation quality', ' high ')
    form.field('Available generation qualities (comma-separated)', 'low, high, high')
    form.field('Generation extra fields (JSON)', '{"watermark":false,"prompt_extend":false}')
    form.save()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('openaiCompatExtraBody', { watermark: false, prompt_extend: false }))
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatSizes', { '16:9': { '2K': '2048x1152' } })
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatQuality', 'high')
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatQualityOptions', ['low', 'high'])
  })
  it.each(['[]', '{broken'])('rejects invalid generation JSON %s before any settings or key write', async invalid => {
    const form = formHarness()
    form.typeKey('test-draft')
    form.field('Generation extra fields (JSON)', invalid)
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('Extra JSON fields must be a valid JSON object.'))
    expect(form.setSetting).not.toHaveBeenCalled()
    expect(form.setKey).not.toHaveBeenCalled()
  })
  it('rejects unsupported official sizes before saving any field', async () => {
    const form = formHarness('en', { openaiModel: 'gpt-image-2' }, 'openai')
    form.field('Custom resolution table (JSON)', '{"1:1":{"4K":"4096x4096"}}')
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('size'))
    expect(form.setSetting).not.toHaveBeenCalled()
  })
  it.each(['Fetch models', 'Test connection'])('asks to save before %s without sending a request or storing the draft', async action => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async (): Promise<Record<string, unknown>> => ({ ok: false, reason: 'missing-key' }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness()
    form.typeKey('  sk-draft  ')
    form.click(action)
    await vi.waitFor(() => expect(form.rowText()).toContain('Save the API key first, then fetch models or test the connection.'))
    expect(fetch).not.toHaveBeenCalled()
    expect(form.setKey).not.toHaveBeenCalled()
    expect(form.keyValue()).toBe('  sk-draft  ')
  })

  it('also blocks probing a replacement key when a previous key was saved', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('en')
    form.typeKey('sk-old')
    form.save()
    await vi.waitFor(() => expect(form.keyValue()).toBe(''))
    form.typeKey('sk-replacement')
    form.click('Test connection')
    expect(form.rowText()).toContain('Save the API key first')
    expect(fetch).not.toHaveBeenCalled()
    expect(form.setKey).toHaveBeenCalledTimes(1)
  })

  it('clears old model and connection errors after saving, then allows model fetching', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async (): Promise<Record<string, unknown>> => ({ ok: false, reason: 'missing-key' }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness()
    form.click('Fetch models')
    await vi.waitFor(() => expect(form.rowText()).toContain('Key missing'))
    form.click('Test connection')
    await vi.waitFor(() => expect(form.rowText().match(/Key missing/g)).toHaveLength(2))
    form.typeKey('  sk-saved  ')
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('Saved'))
    expect(form.setKey).toHaveBeenCalledWith('DSH_STUDIO_OPENAI_COMPAT_KEY', 'sk-saved')
    expect(form.keyValue()).toBe('')
    expect(form.rowText()).not.toContain('Key missing')
    fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, models: ['gpt-image-1'] }) })
    form.click('Fetch models')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(JSON.parse(fetch.mock.calls[2]![1].body as string)).toEqual({ provider: 'openai-compat', action: 'models' })
  })

  it.each(['Fetch models', 'Test connection'])('disables saving until the outstanding %s request finishes', async action => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const form = formHarness()
    form.click(action)
    expect(form.disabled('Save')).toBe(true)
    finish(new Response(JSON.stringify({ ok: false, reason: 'missing-key' })))
    await vi.waitFor(() => expect(form.disabled('Save')).toBe(false))
  })

  it('disables model fetching and probing while the key is being saved', async () => {
    const form = formHarness()
    let finish!: () => void
    form.setSetting.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    form.typeKey('sk-draft')
    form.save()
    expect(form.disabled('Fetch models')).toBe(true)
    expect(form.disabled('Test connection')).toBe(true)
    finish()
    await vi.waitFor(() => expect(form.disabled('Test connection')).toBe(false))
    expect(form.disabled('Fetch models')).toBe(false)
  })

  it('preserves the draft and earlier model error when saving fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, reason: 'missing-key' }) })))
    const form = formHarness()
    form.click('Fetch models')
    await vi.waitFor(() => expect(form.rowText()).toContain('Key missing'))
    form.typeKey('sk-draft')
    form.setSetting.mockRejectedValueOnce(new Error('Settings unavailable'))
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('Settings unavailable'))
    expect(form.rowText()).toContain('Key missing')
    expect(form.keyValue()).toBe('sk-draft')
    expect(form.setKey).not.toHaveBeenCalled()
  })
})

describe('settings card compat channels', () => {
  it('places the add button after the default channel disclosure', () => {
    const form = formHarness()
    const children = form.providerHeadChildren()
    expect(children[0]!.props.className).toBe('dsh-st-provider-head')
    expect(children[1]!.props['aria-label']).toBe('Add OpenAI-compatible channel')
  })

  it('removes an unsaved draft immediately without writing settings', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) })
    const form = formHarness()
    form.addChannel()
    expect(form.channelExists()).toBe(true)
    form.removeChannel()
    await vi.waitFor(() => expect(form.channelExists()).toBe(false))
    expect(form.setSetting).not.toHaveBeenCalled()
  })

  it('saves a newly added channel with its own endpoint and model', async () => {
    const form = formHarness()
    form.addChannel()
    form.channelField('Endpoint / Base URL', 'https://relay-b.example/v1')
    form.channelField('Default model', 'relay-b-model')
    form.saveChannel()
    await vi.waitFor(() => expect(form.setSetting).toHaveBeenCalledWith('openaiCompatChannels', [
      expect.objectContaining({ label: 'OpenAI-compatible 2', baseURL: 'https://relay-b.example/v1', model: 'relay-b-model', models: ['relay-b-model'] }),
    ]))
    expect(form.channelExists()).toBe(true)
  })

  it('removes a persisted channel after the accepted write and resets its active selection', async () => {
    vi.stubGlobal('window', { confirm: vi.fn(() => true) })
    const form = formHarness('en', {
      openaiCompatActiveChannel: 'relay-b',
      openaiCompatChannels: [{ id: 'relay-b', label: 'Relay B', keyRef: 'DSH_STUDIO_OPENAI_COMPAT_KEY_RELAY_B', baseURL: 'https://relay-b.example/v1', model: 'relay-b-model' }],
    })
    expect(form.channelExists()).toBe(true)
    form.removeChannel()
    await vi.waitFor(() => expect(form.channelExists()).toBe(false))
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatChannels', [])
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatActiveChannel', 'default')
  })
})

describe('settings card host state', () => {
  it('reads a form that became ready between render and subscription instead of staying disabled', () => {
    const state = { writable: true, status: 'loading' as 'loading' | 'ready', mode: 'host' as const }
    const form = formHarness('en', {}, 'openai-compat', state)
    expect(form.disabled('Save')).toBe(true)
    state.status = 'ready'
    form.syncScope()
    expect(form.disabled('Save')).toBe(false)
    expect(form.cardText()).not.toContain('Settings are loading')
  })
  it('explains remote memory mode instead of telling users to edit a profile file', () => {
    const form = formHarness('en', {}, 'openai-compat', { writable: false, status: 'unavailable', mode: 'memory' })
    expect(form.cardText()).toContain('This connection cannot save settings to the host. Edit them from the local DSH page.')
    expect(form.cardText()).not.toContain('Settings come from a profile file and are read-only; edit that source to change them.')
    expect(form.disabled('Save')).toBe(true)
  })

  it('blocks writes while the real host form is loading even when writable is true', async () => {
    const form = formHarness('en', {}, 'openai-compat', { writable: true, status: 'loading', mode: 'host' })
    expect(form.cardText()).toContain('Settings are loading')
    expect(form.disabled('Save')).toBe(true)
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('Settings are loading'))
    expect(form.setSetting).not.toHaveBeenCalled()
    expect(form.setKey).not.toHaveBeenCalled()
  })

  it('explains an unavailable namespace and refuses writes without claiming success', async () => {
    const form = formHarness('en', {}, 'openai-compat', { writable: true, status: 'unavailable', mode: 'host' })
    expect(form.cardText()).toContain('The host has not provided image generation settings. Check that the plugin is enabled and review its load logs.')
    expect(form.disabled('Save')).toBe(true)
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('The host has not provided image generation settings. Check that the plugin is enabled and review its load logs.'))
    expect(form.setSetting).not.toHaveBeenCalled()
  })

  it('keeps an actual read-only document distinct from unavailable services', () => {
    const form = formHarness('en', {}, 'openai-compat', { writable: false, status: 'ready', mode: 'host' })
    expect(form.cardText()).toContain('Settings come from a profile file and are read-only; edit that source to change them.')
    expect(form.cardText()).not.toContain('The host has not provided image generation settings. Check that the plugin is enabled and review its load logs.')
    expect(form.disabled('Save')).toBe(true)
  })
})

describe('settings card endpoint actions', () => {
  it.each(['Fetch models', 'Test connection'])('asks to save a newly entered relay address before %s', async action => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, reason: 'error', message: 'Base URL is not configured' }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('en', {})
    form.typeURL('https://relay.example/v1')
    form.click(action)
    expect(form.rowText()).toContain('The endpoint address has not been saved. Click Save before fetching models or testing the connection.')
    expect(fetch).not.toHaveBeenCalled()
    expect(form.setSetting).not.toHaveBeenCalled()
  })

  it.each(['Fetch models', 'Test connection'])('asks for an empty relay address before %s', action => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('en', {})
    form.click(action)
    expect(form.rowText()).toContain('Enter and save an endpoint address before fetching models or testing the connection.')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['Fetch models', 'Test connection'])('allows %s after the edited address is saved', async action => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, models: ['gpt-image-1'] }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness()
    form.typeURL('https://replacement.example/v1')
    form.click(action)
    expect(fetch).not.toHaveBeenCalled()
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('Saved'))
    expect(form.setSetting).toHaveBeenCalledWith('openaiCompatBaseURL', 'https://replacement.example/v1')
    form.click(action)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  })

  it('keeps blocking requests when the address write is refused', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const form = formHarness()
    form.typeURL('https://replacement.example/v1')
    form.setSetting.mockImplementationOnce(async () => {}).mockResolvedValueOnce(false)
    form.save()
    await vi.waitFor(() => expect(form.rowText()).toContain('A setting could not be saved. Please check and try again.'))
    form.click('Fetch models')
    expect(form.rowText()).toContain('The endpoint address has not been saved. Click Save before fetching models or testing the connection.')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['Fetch models', 'Test connection'])('localizes a missing saved address returned by the host during %s', async action => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, reason: 'error', message: 'Base URL is not configured' }) })))
    const form = formHarness()
    form.click(action)
    await vi.waitFor(() => expect(form.rowText()).toContain('No saved endpoint address was found. Save it and try again.'))
    expect(form.rowText()).not.toContain('Base URL is not configured')
  })

  it('checks edited official addresses too, while allowing unchanged defaults', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fetch)
    const form = formHarness('en', {}, 'openai')
    form.typeURL('https://relay.example/v1')
    form.click('Test connection')
    expect(form.rowText()).toContain('The endpoint address has not been saved')
    expect(fetch).not.toHaveBeenCalled()
    form.typeURL('  https://api.openai.com/v1  ')
    form.click('Test connection')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  })
})

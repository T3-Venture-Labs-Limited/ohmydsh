import { describe, expect, it } from 'vitest'
import { DEFAULT_MODELS } from '../src/shared.js'
import { comfyUIWorkflowWrites, pillButtonLabel, pillModelOf, pillModelOptionsOf, pillVisible } from '../src/client/provider-pill.js'

describe('composer provider pill visibility (opt-in)', () => {
  it('stays hidden by default and only appears when explicitly enabled', () => {
    expect(pillVisible(undefined)).toBe(false)
    expect(pillVisible({})).toBe(false)
    expect(pillVisible({ showProviderPill: false })).toBe(false)
    expect(pillVisible({ showProviderPill: true })).toBe(true)
  })
})

describe('composer provider pill model choices', () => {

  it('normalizes configured model choices without moving an existing default', () => {
    expect(pillModelOptionsOf('openai-compat', {
      openaiCompatModel: 'gpt-image-1.5',
      openaiCompatModels: ['gpt-image-2', ' gpt-image-1.5 ', 'gpt-image-2', ''],
    })).toEqual(['gpt-image-2', 'gpt-image-1.5'])
  })

  it('keeps a legacy default selectable when the saved list omits it', () => {
    expect(pillModelOptionsOf('openai-compat', {
      openaiCompatModel: 'gpt-image-1.5',
      openaiCompatModels: ['gpt-image-2'],
    })).toEqual(['gpt-image-1.5', 'gpt-image-2'])
  })
})

describe('composer provider pill model resolution', () => {

  it('shows no model for an unconfigured compat relay instead of inventing one', () => {
    expect(pillModelOf('openai-compat', {})).toBe('')
    expect(pillModelOf('openai-compat', { openaiCompatModel: '' })).toBe('')
  })

  it('shows the active ComfyUI workflow name, or empty before any import', () => {
    expect(pillModelOf('comfyui', {})).toBe('')
    expect(pillModelOf('comfyui', {
      comfyuiWorkflows: [
        { name: 'flux-dev', json: '{}' },
        { name: 'sd-xl', json: '{}' },
      ],
      comfyuiActiveWorkflow: 'sd-xl',
    })).toBe('sd-xl')
    // Active name missing from the list falls back to the first entry.
    expect(pillModelOf('comfyui', {
      comfyuiWorkflows: [{ name: 'flux-dev', json: '{}' }],
      comfyuiActiveWorkflow: 'gone',
    })).toBe('flux-dev')
    // Legacy single-workflow storage still resolves.
    expect(pillModelOf('comfyui', {
      comfyuiWorkflowJson: '{}',
      comfyuiWorkflowName: 'legacy flow',
    })).toBe('legacy flow')
  })
})

describe('composer provider pill ComfyUI workflows (#115)', () => {
  const settings = {
    comfyuiWorkflows: [
      { name: '人像', json: '{"portrait":1}' },
      { name: '动漫8步', json: '{"anime":1}' },
    ],
    comfyuiActiveWorkflow: '人像',
  }

  it('lists imported workflows as the ComfyUI submenu, and nothing before an import', () => {
    expect(pillModelOptionsOf('comfyui', settings)).toEqual(['人像', '动漫8步'])
    expect(pillModelOptionsOf('comfyui', {})).toEqual([])
    expect(pillModelOptionsOf('comfyui', { comfyuiWorkflowJson: '{}', comfyuiWorkflowName: 'legacy flow' })).toEqual(['legacy flow'])
  })

  it('writes the same three fields as the settings card for the picked workflow', () => {
    expect(comfyUIWorkflowWrites(settings, '动漫8步')).toEqual([
      ['comfyuiActiveWorkflow', '动漫8步'],
      ['comfyuiWorkflowJson', '{"anime":1}'],
      ['comfyuiWorkflowName', '动漫8步'],
    ])
    expect(comfyUIWorkflowWrites(settings, 'gone')).toBeUndefined()
  })

  it('names the active workflow on the pill button', () => {
    expect(pillButtonLabel('comfyui', 'ComfyUI', settings)).toBe('ComfyUI · 人像')
    expect(pillButtonLabel('comfyui', 'ComfyUI', {})).toBe('ComfyUI')
    expect(pillButtonLabel('openai-compat', 'OpenAI-compatible', settings, 'My relay')).toBe('My relay')
    expect(pillButtonLabel('google', 'Gemini', settings)).toBe('Gemini')
  })
})

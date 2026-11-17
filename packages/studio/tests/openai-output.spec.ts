import { describe, expect, it } from 'vitest'
import { compatQualityOptions, compatRequestQuality, compatWatermarkField, gifRequestFields, officialQualityOptions, officialSizeTable, outputRequestFields, PROVIDER_DEFAULT_QUALITY, validateGifFrameSize, validateOfficialSize } from '../src/openai-output.js'
import { parseExtraFields, parseSizeTable } from '../src/client/output-settings.js'

describe('independent OpenAI output parameters', () => {
  it.each(['2048x2048', '2048x1152', '3840x2160', '2160x3840'])('accepts the official flexible size %s', size => {
    expect(() => validateOfficialSize('gpt-image-2', size)).not.toThrow()
  })
  it.each(['4096x4096', '2049x1152', '3840x3840', '512x512', '3840x1024', 'bad'])('rejects the unsupported official size %s', size => {
    expect(() => validateOfficialSize('gpt-image-2', size)).toThrow('size')
  })
  it('keeps old official models within their size and quality contract', () => {
    expect(() => validateOfficialSize('gpt-image-1.5', '2048x2048')).toThrow('does not support')
    expect(Object.keys(officialSizeTable({}, 'gpt-image-1.5'))).toEqual(['1:1', '3:2', '2:3'])
    expect(officialQualityOptions('gpt-image-2').map(option => option.value)).not.toContain('max')
    expect(officialQualityOptions('gpt-image-2.5-flare').map(option => option.value)).toContain('max')
  })
  it('distinguishes explicit omission, a configured default and a per-call override', () => {
    expect(compatRequestQuality({})).toBeUndefined()
    expect(compatRequestQuality({ openaiCompatQuality: 'high' })).toBe('high')
    expect(compatRequestQuality({ openaiCompatQuality: 'high' }, 'low')).toBe('low')
    expect(compatRequestQuality({ openaiCompatQuality: 'high' }, PROVIDER_DEFAULT_QUALITY)).toBeUndefined()
    expect(compatQualityOptions({ openaiCompatQualityOptions: ['draft', 'best'], openaiCompatQuality: 'custom' }).map(option => option.value)).toEqual([PROVIDER_DEFAULT_QUALITY, 'draft', 'best', 'custom'])
  })
  it('validates advanced JSON without losing false or nested provider fields', () => {
    expect(parseExtraFields('{"watermark":false,"vendor":{"strength":0}}', 'invalid')).toEqual({ watermark: false, vendor: { strength: 0 } })
    expect(parseSizeTable('{"16:9":{"2K":"2048x1152"}}', 'invalid')).toEqual({ '16:9': { '2K': '2048x1152' } })
    for (const text of ['[]', '{bad', '{"16:9":{"bad":"2048x1152"}}', '{"16:9":{"2K":false}}']) expect(() => parseSizeTable(text, 'invalid')).toThrow('invalid')
  })
})

describe('compatible watermark contracts', () => {
  it('recognizes the exact official SenseNova endpoint without guessing from a model name', () => {
    const config = { openaiCompatBaseURL: 'https://token.sensenova.cn/v1/', openaiCompatModel: 'sensenova-u1.5-lite' }
    expect(compatWatermarkField(config)).toBe('watermark')
    for (const address of ['https://relay.example/v1', 'https://token.sensenova.cn.evil.example/v1', 'https://token.sensenova.cn:8443/v1', 'https://token.sensenova.cn/other', 'http://token.sensenova.cn/v1']) {
      expect(compatWatermarkField({ ...config, openaiCompatBaseURL: address })).toBeUndefined()
    }
    expect(compatWatermarkField({ ...config, openaiCompatModel: 'other' })).toBeUndefined()
    expect(compatWatermarkField({ ...config, openaiCompatExtraBody: { model: 'other' } })).toBeUndefined()
  })
  it('uses existing boolean fields as configuration, rather than inferring a relay provider', () => {
    expect(compatWatermarkField({ openaiCompatExtraBody: { watermark: false } })).toBe('watermark')
    expect(compatWatermarkField({ openaiCompatExtraBody: { watermark_enabled: true } })).toBe('watermark_enabled')
    expect(compatWatermarkField({ openaiCompatExtraBody: { parameters: { watermark: false } } })).toBe('parameters.watermark')
    expect(compatWatermarkField({ openaiCompatExtraBody: { watermark: 'false' } })).toBeUndefined()
  })
})

describe('SVG output parameters', () => {
  it('asks for a single vector document and sends nothing else', () => {
    expect(outputRequestFields({ outputFormat: 'svg' })).toEqual({ output_format: 'svg' })
  })
  it('refuses an output format outside the OpenAI images contract', () => {
    expect(() => outputRequestFields({ outputFormat: 'webp' })).toThrow('output_format')
  })
})


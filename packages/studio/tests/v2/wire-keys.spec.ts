import { afterEach, describe, expect, it } from 'vitest'
import { resolveKey } from '../../src/v2/wire.js'

const ctxWith = (values: Record<string, string>) => ({ credentials: { resolve: async (ref: unknown) => { const v = values[String(ref)]; return v === undefined ? undefined : { value: v } } } }) as never
afterEach(() => { delete process.env.TEST_STUDIO_KEY; delete process.env.DSH_IMAGE_GEN_OPENAI_COMPAT_KEY })

describe('resolveKey', () => {
  it('prefers a stored credential, then the environment, and ignores blanks', async () => {
    expect(await resolveKey(ctxWith({ REPLICATE_API_TOKEN: '  r8_x ' }), 'REPLICATE_API_TOKEN')).toBe('r8_x')
    process.env.TEST_STUDIO_KEY = 'from-env'
    expect(await resolveKey(ctxWith({}), 'TEST_STUDIO_KEY')).toBe('from-env')
    expect(await resolveKey(ctxWith({ TEST_STUDIO_KEY: '   ' }), 'TEST_STUDIO_KEY')).toBe('from-env')
    expect(await resolveKey(ctxWith({}), 'NOPE_NOT_SET')).toBeUndefined()
  })

  it('falls back from DSH_STUDIO_* to the old plugin\'s DSH_IMAGE_GEN_* relay key, with the new one winning', async () => {
    expect(await resolveKey(ctxWith({ DSH_IMAGE_GEN_OPENAI_COMPAT_KEY: 'old-relay' }), 'DSH_STUDIO_OPENAI_COMPAT_KEY')).toBe('old-relay')
    expect(await resolveKey(ctxWith({ DSH_IMAGE_GEN_OPENAI_COMPAT_KEY: 'old', DSH_STUDIO_OPENAI_COMPAT_KEY: 'new' }), 'DSH_STUDIO_OPENAI_COMPAT_KEY')).toBe('new')
    expect(await resolveKey(ctxWith({ DSH_STUDIO_OPENAI_COMPAT_KEY_ACME: 'x' }), 'DSH_STUDIO_OPENAI_COMPAT_KEY_ACME')).toBe('x')
    expect(await resolveKey(ctxWith({ DSH_IMAGE_GEN_OPENAI_COMPAT_KEY_ACME: 'old-acme' }), 'DSH_STUDIO_OPENAI_COMPAT_KEY_ACME')).toBe('old-acme')
  })

  it('a throwing credentials service falls through to the environment instead of failing', async () => {
    process.env.TEST_STUDIO_KEY = 'env'
    expect(await resolveKey({ credentials: { resolve: async () => { throw new Error('store locked') } } } as never, 'TEST_STUDIO_KEY')).toBe('env')
  })
})

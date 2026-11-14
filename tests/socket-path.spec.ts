import { describe, expect, it } from 'vitest'
import { defaultSocketPath } from '../src/host/socket-path.ts'

describe('socket path', () => {
  it('is scoped to DSH_HOME', () => {
    const dev = defaultSocketPath({ DSH_HOME: '/home/u/.dsh-dev', XDG_RUNTIME_DIR: '/run/user/1' })
    const web = defaultSocketPath({ DSH_HOME: '/home/u/.dsh', XDG_RUNTIME_DIR: '/run/user/1' })
    expect(dev).toMatch(/^\/run\/user\/1\/dsh-hud-[0-9a-f]{8}\.sock$/)
    expect(dev).not.toBe(web)
  })
  it('is stable for the same home', () => {
    const env = { DSH_HOME: '/x/y', XDG_RUNTIME_DIR: '/r' }
    expect(defaultSocketPath(env)).toBe(defaultSocketPath({ ...env }))
  })
})

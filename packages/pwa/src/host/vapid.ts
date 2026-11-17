import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import webpush from 'web-push'

export interface VapidKeys {
  readonly publicKey: string
  readonly privateKey: string
}

const B64URL = /^[A-Za-z0-9_-]+$/

function valid(value: unknown): value is VapidKeys {
  if (value === null || typeof value !== 'object') return false
  const { publicKey, privateKey } = value as Record<string, unknown>
  return typeof publicKey === 'string' && typeof privateKey === 'string' && B64URL.test(publicKey) && B64URL.test(privateKey) && publicKey.length === 87 && privateKey.length === 43
}

/**
 * The VAPID key pair for this DSH home: generated once, then read back on every start so subscriptions stay valid.
 * Stored at `<dir>/vapid.json` with mode 0600 inside a 0700 directory. A damaged file is never silently replaced
 * (that would orphan every subscription): it throws and the push routes answer 503.
 */
export async function loadVapid(dir: string): Promise<VapidKeys> {
  const file = join(dir, 'vapid.json')
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!valid(parsed)) throw new Error(`${file} does not hold a VAPID key pair; delete it to generate a new one (all devices must then subscribe again)`)
    await chmod(file, 0o600).catch(() => {})
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const keys = webpush.generateVAPIDKeys()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date().toISOString() }), { mode: 0o600 })
  await rename(tmp, file)
  return { publicKey: keys.publicKey, privateKey: keys.privateKey }
}

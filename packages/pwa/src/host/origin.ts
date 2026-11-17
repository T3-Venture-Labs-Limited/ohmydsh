// Chooses the address a phone should use to reach this DSH: Tailscale HTTPS name first, then the address the page is
// already open at, then the LAN IP. Every external probe is injectable so the choice is unit-tested.
import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'

export type OriginKind = 'tailscale' | 'request' | 'lan'

export interface OriginChoice {
  /** `https://name.tailnet.ts.net` or `http://192.168.1.20:3080` (no trailing slash). */
  readonly origin: string
  readonly kind: OriginKind
  /** True when the phone can reach it from a browser PWA too (HTTPS); plain http only works inside the native app. */
  readonly secure: boolean
  readonly warnings: readonly string[]
}

export interface OriginInput {
  /** How DSH listens: bind address, port, protocol. */
  readonly bind: { host: string; port: number; protocol: 'http:' | 'https:' }
  /** The Host header of the request that asked for pairing, e.g. `127.0.0.1:3080` or `laptop.tail1234.ts.net`. */
  readonly requestHost: string | undefined
  readonly exec?: (file: string, args: string[]) => Promise<string>
  readonly interfaces?: () => Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>
}

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?)$/i

export function hostnameOf(authority: string): string {
  try { return new URL(`http://${authority}`).hostname } catch { return authority }
}

export const isLoopbackAuthority = (authority: string): boolean => LOOPBACK.test(hostnameOf(authority))

function defaultExec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2500, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => { if (error) reject(error); else resolve(stdout) })
  })
}

interface TailscaleFacts { name: string; serving: boolean; httpsPort: number | undefined; magicDns: boolean }

/** Reads `tailscale status --json` and `tailscale serve status --json`; undefined when Tailscale is absent or not running. */
export async function tailscaleFacts(port: number, exec: (file: string, args: string[]) => Promise<string>): Promise<TailscaleFacts | undefined> {
  let status: { BackendState?: string; Self?: { DNSName?: string }; CurrentTailnet?: { MagicDNSEnabled?: boolean } }
  try { status = JSON.parse(await exec('tailscale', ['status', '--json'])) } catch { return undefined }
  if (status.BackendState !== 'Running') return undefined
  const name = (status.Self?.DNSName ?? '').replace(/\.$/, '')
  if (name === '') return undefined
  let serving = false
  let httpsPort: number | undefined
  try {
    const serve = JSON.parse(await exec('tailscale', ['serve', 'status', '--json'])) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
    for (const [key, web] of Object.entries(serve.Web ?? {})) {
      for (const handler of Object.values(web.Handlers ?? {})) {
        if (typeof handler.Proxy === 'string' && new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(/|$)`).test(handler.Proxy)) {
          serving = true
          const p = Number(key.slice(key.lastIndexOf(':') + 1))
          httpsPort = Number.isFinite(p) ? p : 443
        }
      }
    }
  } catch { /* serve not configured */ }
  return { name, serving, httpsPort, magicDns: status.CurrentTailnet?.MagicDNSEnabled !== false }
}

export function lanAddress(interfaces: NonNullable<OriginInput['interfaces']> = networkInterfaces as never): string | undefined {
  const found: string[] = []
  for (const list of Object.values(interfaces())) {
    for (const item of list ?? []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal && !item.address.startsWith('169.254.')) found.push(item.address)
    }
  }
  const isPrivate = (a: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)
  // Tailscale's own 100.64/10 address is not a LAN address.
  return found.find(isPrivate) ?? found.find((a) => !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a))
}

export async function chooseOrigin(input: OriginInput): Promise<OriginChoice> {
  const { bind, requestHost } = input
  const exec = input.exec ?? defaultExec
  const warnings: string[] = []

  // 1. The page is already open at a non-loopback name: that exact origin is known to work for this browser.
  const secureBind = bind.protocol === 'https:'
  if (requestHost !== undefined && requestHost !== '' && !isLoopbackAuthority(requestHost)) {
    const tailnet = /\.ts\.net(:\d+)?$/i.test(requestHost)
    const scheme = secureBind || tailnet ? 'https' : 'http'
    return { origin: `${scheme}://${requestHost}`, kind: tailnet ? 'tailscale' : 'request', secure: scheme === 'https', warnings: scheme === 'http' ? [PLAIN_HTTP] : [] }
  }

  // 2. Tailscale HTTPS in front of this DSH.
  const ts = await tailscaleFacts(bind.port, exec)
  if (ts !== undefined && ts.serving) {
    const suffix = ts.httpsPort === undefined || ts.httpsPort === 443 ? '' : `:${ts.httpsPort}`
    return { origin: `https://${ts.name}${suffix}`, kind: 'tailscale', secure: true, warnings: [`DSH must trust this name: start it with --trusted-host ${ts.name}`] }
  }

  // 3. LAN IP.
  const lan = lanAddress(input.interfaces)
  if (lan !== undefined) {
    if (isLoopbackAuthority(bind.host)) {
      warnings.push(`DSH listens on ${bind.host} only, so a phone cannot reach it yet. Restart it with --host ${lan} --trusted-host ${lan}, or use Tailscale: tailscale serve --bg --https=443 http://127.0.0.1:${bind.port}`)
    } else if (bind.host !== lan) {
      warnings.push(`DSH is bound to ${bind.host}, not ${lan}; use an address it listens on`)
    }
    if (!secureBind) warnings.push(PLAIN_HTTP)
    const scheme = secureBind ? 'https' : 'http'
    return { origin: `${scheme}://${lan}:${bind.port}`, kind: 'lan', secure: secureBind, warnings }
  }
  if (ts !== undefined) {
    warnings.push(`Tailscale is running but not serving DSH. Run: tailscale serve --bg --https=443 http://127.0.0.1:${bind.port}`)
    return { origin: `https://${ts.name}`, kind: 'tailscale', secure: true, warnings }
  }
  warnings.push('No network address found. Connect this computer to Wi-Fi or Tailscale.')
  return { origin: `${secureBind ? 'https' : 'http'}://127.0.0.1:${bind.port}`, kind: 'lan', secure: secureBind, warnings }
}

const PLAIN_HTTP = 'Plain http over Wi-Fi works only inside the ohmydsh app, not in a browser app (PWA). Anyone on the same network can read plain http traffic: use Tailscale HTTPS when you can.'

export interface PairLinks { app: string; web: string }

/** `ohmydsh://pair?u=<origin>&c=<code>` for the app and `<origin>/app/pair#<code>` for a plain link. */
export function pairLinks(origin: string, code: string): PairLinks {
  return { app: `ohmydsh://pair?u=${encodeURIComponent(origin)}&c=${encodeURIComponent(code)}`, web: `${origin}/app/pair#${code}` }
}

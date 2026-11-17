// Makes "Remove" real. Core's sign-in cookie is a stateless signed value, so core alone cannot revoke it. A paired device
// gets its own cookie recorded by DeviceStore; this gate then refuses exactly those cookies at core's admission (every route
// that calls requestRejection, the /api bridge, the WebSocket upgrade), and closes the device's open WebSockets the moment
// it is removed.
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DeviceStore } from './pairing.ts'

type Admit = (request: { headers: IncomingMessage['headers'] | Headers }) => unknown

type AuthorizeIndex = (request: { method?: string; url?: string; headers: IncomingMessage['headers'] }, response: { writeHead(status: number, headers?: Record<string, string>): unknown; end(body?: string): unknown }) => boolean

export interface GateTarget { admit?: Admit; authorizeIndex?: AuthorizeIndex }
export interface UpgradeServer {
  prependListener(event: 'upgrade', fn: (req: IncomingMessage, socket: Duplex) => void): unknown
  removeListener(event: 'upgrade', fn: (req: IncomingMessage, socket: Duplex) => void): unknown
}

function cookieOf(headers: IncomingMessage['headers'] | Headers): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get('cookie') ?? undefined
  const value = (headers as IncomingMessage['headers'])['cookie']
  return typeof value === 'string' ? value : undefined
}

/**
 * Wrap `connection.admit` so a revoked device cookie is refused with 401. The original runs first, so its Host/Origin
 * rejection still wins. Returns the disposer that restores the original.
 */
export function installAdmitGate(connection: GateTarget, devices: DeviceStore): () => void {
  const original = connection.admit
  const originalIndex = connection.authorizeIndex
  if (typeof original !== 'function') return () => {}
  const wrapped: Admit = function (this: unknown, request) {
    const result = original.call(this ?? connection, request) as { rejection?: number } | undefined
    if (result !== undefined && 'rejection' in result) return result
    return devices.isRevokedCookie(cookieOf(request.headers)) ? { rejection: 401 } : result
  }
  connection.admit = wrapped
  // The page shell (`/`) is authorised by a separate core method; a removed device gets no shell either.
  let wrappedIndex: AuthorizeIndex | undefined
  if (typeof originalIndex === 'function') {
    wrappedIndex = function (this: unknown, request, response) {
      if (devices.isRevokedCookie(cookieOf(request.headers))) {
        response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
        response.end('This device was removed in DSH. Pair it again.\n')
        return false
      }
      return originalIndex.call(this ?? connection, request, response)
    }
    connection.authorizeIndex = wrappedIndex
  }
  return () => {
    if (connection.admit === wrapped) connection.admit = original
    if (wrappedIndex !== undefined && connection.authorizeIndex === wrappedIndex) { if (originalIndex === undefined) delete connection.authorizeIndex; else connection.authorizeIndex = originalIndex }
  }
}

/** Track the open upgraded sockets (the Remote mux WebSocket) per paired device so removal ends them at once. */
export function trackDeviceSockets(server: UpgradeServer | undefined, devices: DeviceStore): { dispose(): void; closeDevice(id: string): number } {
  const sockets = new Map<string, Set<Duplex>>()
  if (server === undefined) return { dispose() {}, closeDevice: () => 0 }
  const onUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    const cookie = typeof req.headers['cookie'] === 'string' ? req.headers['cookie'] : undefined
    if (devices.isRevokedCookie(cookie)) { socket.destroy(); return }
    const id = devices.deviceForCookie(cookie)
    if (id === undefined) return
    let set = sockets.get(id)
    if (set === undefined) { set = new Set(); sockets.set(id, set) }
    const mine = set
    mine.add(socket)
    socket.once('close', () => { mine.delete(socket); if (mine.size === 0) sockets.delete(id) })
  }
  server.prependListener('upgrade', onUpgrade)
  return {
    dispose: () => { server.removeListener('upgrade', onUpgrade); sockets.clear() },
    closeDevice: (id) => {
      const set = sockets.get(id)
      if (set === undefined) return 0
      const n = set.size
      for (const socket of set) socket.destroy()
      sockets.delete(id)
      return n
    },
  }
}

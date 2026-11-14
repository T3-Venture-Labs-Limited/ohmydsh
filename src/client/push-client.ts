// Browser side of Web Push: talks to the plugin's own routes with the page's HttpOnly sign-in cookie.
export type PushSupport = 'ok' | 'insecure' | 'unsupported'

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure'
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'ok' : 'unsupported'
}

export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T
  if (!response.ok || body.ok === false) throw new Error(body.error ?? `request failed (${response.status})`)
  return body
}

const post = <T,>(path: string, body: unknown): Promise<T> => call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** The worker registration for this origin, waiting briefly for the registration the host index script starts. */
export async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  const ready = navigator.serviceWorker.ready
  const timeout = new Promise<undefined>((resolve) => { setTimeout(resolve, 8000) })
  return Promise.race([ready, timeout])
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration()
  return reg === undefined ? null : reg.pushManager.getSubscription()
}

export async function enablePush(label: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings.')
  const reg = await registration()
  if (reg === undefined) throw new Error('The service worker is not ready yet. Reload the page and try again.')
  const { publicKey } = await call<{ publicKey: string }>('/push/key')
  let subscription = await reg.pushManager.getSubscription()
  const wanted = urlBase64ToBytes(publicKey)
  const have = subscription?.options.applicationServerKey
  if (subscription !== null && have !== null && have !== undefined && !sameBytes(new Uint8Array(have), wanted)) {
    // The host's key pair changed: an old subscription can never receive anything again.
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted })
  await post('/push/subscribe', { subscription: subscription.toJSON(), label })
  return subscription
}

export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription === null) return
  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  await post('/push/unsubscribe', { endpoint }).catch(() => {})
}

export async function sendTest(): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription === null) throw new Error('This device is not subscribed.')
  await post('/push/test', { endpoint: subscription.endpoint })
}

/** Re-store a local subscription on the host (idempotent), healing a host that lost its subscription file. */
export async function resync(subscription: PushSubscription): Promise<void> {
  await post('/push/subscribe', { subscription: subscription.toJSON() }).catch(() => {})
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

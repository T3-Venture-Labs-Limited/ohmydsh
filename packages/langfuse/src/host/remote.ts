// Browser -> Host endpoints without Typert codegen (same registration trick as dsh-quorfloat's remote-gateway).
// The Gateway admits the peer before dispatch; both methods here are read-only.
import type { Context } from '@deepseek-ai/cordis'

const DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export interface RemoteMethod { readonly method: string; readonly implementation: (...args: never[]) => unknown }

export function registerRemoteService(ctx: Context, serviceKey: string, namespace: string, methods: readonly RemoteMethod[]): () => void {
  const service: Record<string, unknown> = {}
  Object.defineProperty(service, 'ctx', { value: ctx, enumerable: false, writable: true })
  Object.defineProperty(service, 'name', { value: serviceKey, enumerable: false, writable: true })
  Object.defineProperty(service, 'typertRemote', { value: Object.freeze({ service, serviceKey, namespace }), enumerable: false })
  const prototype: Record<string, unknown> = {}
  for (const { method, implementation } of methods) {
    Object.defineProperty(prototype, method, { value: implementation, enumerable: false, writable: false })
  }
  Object.defineProperty(prototype, DESCRIPTOR, {
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map(({ method }) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
    }),
    enumerable: false,
  })
  Object.setPrototypeOf(service, prototype)
  return (ctx as unknown as { reflect: { provide(key: string, service: unknown): () => void } }).reflect.provide(serviceKey, service)
}

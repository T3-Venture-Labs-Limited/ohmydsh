// Browser-side calls to the Host's langfuse endpoints. A failed call is a null answer, never an exception into React.
export interface TraceLink { ok: boolean; url?: string; traceId?: string; reason?: string }
export interface TraceStatus { enabled: boolean; reason?: string; baseUrl?: string; environment?: string }

export interface Rpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
}
export interface Face {
  traceFor(sessionId: string, messageId: string): Promise<TraceLink | null>
  status(): Promise<TraceStatus | null>
}

const CHANNEL = '/api'

export function createFace(rpc: Rpc): Face {
  const call = async (endpoint: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const result = await rpc.call(CHANNEL, endpoint, { args })
      return result.ok === true ? result.value : null
    } catch {
      return null
    }
  }
  return {
    traceFor: async (sessionId, messageId) => {
      const v = await call('langfuse/traceFor', { sessionId, messageId })
      return v !== null && typeof v === 'object' ? (v as TraceLink) : null
    },
    status: async () => {
      const v = await call('langfuse/status', {})
      return v !== null && typeof v === 'object' ? (v as TraceStatus) : null
    },
  }
}

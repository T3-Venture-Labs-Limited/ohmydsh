// Gallery data hook: query + pagination, live inserts from SSE asset events, optimistic favourite toggles.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { onAsset } from './live.js'
import type { AssetQuery, AssetRecord } from './types.js'
import { createStore } from './store.js'

const PAGE = 48

/** Asset records seen anywhere (so lightbox/tool cards render instantly and stay in sync). */
export const assetCache = createStore<Record<string, AssetRecord>>({})
export function cacheAssets(items: readonly AssetRecord[]): void {
  assetCache.set(state => { const next = { ...state }; for (const item of items) next[item.id] = item; return next })
}
export function patchCached(id: string, patch: Partial<AssetRecord>): void {
  assetCache.set(state => (state[id] === undefined ? state : { ...state, [id]: { ...state[id]!, ...patch } }))
}

export function matches(asset: AssetRecord, query: AssetQuery): boolean {
  if (asset.deletedAt !== undefined) return false
  if (query.kind !== undefined && asset.kind !== query.kind) return false
  if (query.favorite === true && !asset.favorite) return false
  if (query.fromChats === true && asset.source !== 'agent' && asset.sessionId === undefined) return false
  if (query.tag !== undefined && !asset.tags.includes(query.tag)) return false
  if (query.model !== undefined && asset.modelId !== query.model) return false
  if (query.q !== undefined && query.q.trim() !== '') return false // text/collection/parent filters are resolved server-side
  if (query.collection !== undefined || query.parent !== undefined) return false
  return true
}

export function useGalleryData(query: AssetQuery, enabled = true) {
  const [items, setItems] = useState<AssetRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const generation = useRef(0)
  const key = JSON.stringify(query)
  const queryRef = useRef(query)
  queryRef.current = query

  const load = useCallback(async (offset: number, replace: boolean) => {
    const mine = ++generation.current
    setLoading(true)
    try {
      const page = await api.assets(queryRef.current, { limit: PAGE, offset })
      if (mine !== generation.current) return
      cacheAssets(page.items)
      setItems(prev => (replace ? page.items : [...prev, ...page.items.filter(i => !prev.some(p => p.id === i.id))]))
      setTotal(page.total)
      setError(undefined)
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => { if (enabled) void load(0, true) }, [key, enabled, load])

  useEffect(() => onAsset((asset) => {
    cacheAssets([asset])
    setItems(prev => {
      if (prev.some(p => p.id === asset.id)) return prev.map(p => (p.id === asset.id ? asset : p))
      if (!matches(asset, queryRef.current)) return prev
      setTotal(n => n + 1)
      return [asset, ...prev]
    })
  }), [])

  const update = useCallback((id: string, patch: Partial<AssetRecord>) => {
    setItems(prev => {
      const next = prev.map(i => (i.id === id ? { ...i, ...patch } : i))
      return queryRef.current.favorite === true && patch.favorite === false ? next.filter(i => i.id !== id) : next
    })
    patchCached(id, patch)
  }, [])
  const remove = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids)
    setItems(prev => prev.filter(i => !gone.has(i.id)))
    setTotal(n => Math.max(0, n - ids.length))
  }, [])
  const more = useCallback(() => { if (!loading) void load(items.length, false) }, [load, loading, items.length])
  const reload = useCallback(() => load(0, true), [load])
  return useMemo(() => ({ items, total, loading, error, more, reload, update, remove, hasMore: items.length < total }), [items, total, loading, error, more, reload, update, remove])
}

export async function toggleFavorite(asset: AssetRecord, update: (id: string, patch: Partial<AssetRecord>) => void): Promise<void> {
  const next = !asset.favorite
  update(asset.id, { favorite: next })
  try { await api.patchAsset(asset.id, { favorite: next }) } catch { update(asset.id, { favorite: !next }) }
}

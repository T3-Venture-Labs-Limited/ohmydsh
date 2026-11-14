import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  set(next: T | ((state: T) => T)): void
  subscribe(listener: () => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (s: T) => T)(state) : next
      if (Object.is(value, state)) return
      state = value
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/** Subscribe a component to a store slice. The selector must return a stable reference (state fields, not fresh objects). */
export function useStore<T, S>(store: Store<T>, select: (state: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()))
}

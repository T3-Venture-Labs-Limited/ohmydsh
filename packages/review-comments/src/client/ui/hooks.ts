import { useSyncExternalStore } from 'react'

export function useVersion(subscribe: (l: () => void) => () => void, getSnapshot: () => number): number {
  return useSyncExternalStore(subscribe, getSnapshot)
}

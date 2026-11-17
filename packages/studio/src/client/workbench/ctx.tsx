import { createContext, useContext } from 'react'
import type { ComposerPrefill, StudioTab } from '../studio-bus.js'

export interface WorkbenchApi {
  /** Switch tab. */
  go(tab: StudioTab): void
  /** Open the lightbox on an asset; `siblings` enables prev/next. */
  openAsset(id: string, siblings?: readonly string[]): void
  /** Open the composer with a prefilled request. */
  compose(prefill: ComposerPrefill): void
  /** Open the HyperFrames pane with clips. */
  hyperframes(assetIds: string[]): void
  /** Transient message. */
  toast(message: string, tone?: 'ok' | 'err'): void
  /** Wide layout (full workbench) vs sidebar. */
  wide: boolean
}

export const WorkbenchContext = createContext<WorkbenchApi | undefined>(undefined)
export function useWorkbench(): WorkbenchApi {
  const value = useContext(WorkbenchContext)
  if (value === undefined) throw new Error('WorkbenchContext missing')
  return value
}

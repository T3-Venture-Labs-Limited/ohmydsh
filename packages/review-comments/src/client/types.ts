// Data model shared by the store, adapters, formatter and UI.

export interface Rect { x: number; y: number; w: number; h: number }
export interface PageRect extends Rect { page: number }

/** Where a comment points. The quote is untrusted text used only to re-find the place; positions are as of the preview at write time. */
export type Anchor =
  | { kind: 'pdf'; page: number; pageEnd: number; rects: PageRect[] }
  | { kind: 'lines'; start: number; end: number; hint: 'exact' | 'searched' | 'none' }
  | { kind: 'cells'; sheet: string; range: string; cellText?: string; formula?: string }
  | { kind: 'message'; nodeKey: string; turn?: string }

export type FileFormat = 'pdf' | 'docx' | 'doc' | 'pptx' | 'ppt' | 'xlsx' | 'xls' | 'csv' | 'tsv' | 'markdown' | 'code' | 'text'
export type Renderer = 'pdf' | 'office' | 'excel' | 'markdown' | 'text' | 'code' | 'bs-markdown' | 'bs-code'

export type Target =
  | { kind: 'file'; path: string; address: string; renderer: Renderer; format: FileFormat }
  | { kind: 'message'; role: 'assistant' | 'user' }

export type CommentStatus = 'open' | 'sent' | 'resolved'

export interface ReviewComment {
  id: string
  /** Stable per-session number shown as RC-n. */
  number: number
  sessionId: string
  target: Target
  anchor: Anchor
  /** The text the reviewer selected, as copied. */
  quote: string
  /** The text-node projection of the selection (used to re-find it in the DOM). */
  find: string
  prefix: string
  suffix: string
  /** Index of this selection among identical matches (disambiguates repeated phrases). */
  occurrence: number
  body: string
  status: CommentStatus
  /** Who resolved it, when status is 'resolved'. */
  resolvedBy?: 'user' | 'agent'
  /** The agent's note on how it was addressed. */
  resolution?: string
  createdAt: number
  updatedAt: number
}

/** A validated live selection, ready to become a comment. */
export interface Capture {
  sessionId: string
  target: Target
  anchor: Anchor
  quote: string
  find: string
  prefix: string
  suffix: string
  occurrence: number
  /** A live range over the selected text (cloned, survives focus moving to the popover). */
  range: Range
  /** The viewer element that owns the selection, used for clipping. */
  viewer: HTMLElement
  /** Resolves approximate source lines for renderers that hide them (markdown); never rejects. */
  resolveAnchor?: () => Promise<Anchor>
}

export type NewComment = Omit<ReviewComment, 'id' | 'number' | 'status' | 'createdAt' | 'updatedAt'>

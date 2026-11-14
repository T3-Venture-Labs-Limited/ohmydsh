/** Wire and document types shared by the host and the browser half. */

export type JsonObject = Record<string, unknown>

/** One notebook cell as the UI and the agent see it (nbformat 4 shape with joined strings). */
export interface WireCell {
  id: string
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  execution_count: number | null
  outputs: JsonObject[]
  metadata: JsonObject
  /** Bumped on every host-side change to this cell. */
  rev: number
  /** `queued` or `running` while the kernel owns the cell. */
  run?: 'queued' | 'running'
  /** Markdown cell attachments (name -> mime bundle), for rendering `attachment:` images. */
  attachments?: JsonObject
}

export type KernelStatus = 'none' | 'starting' | 'idle' | 'busy' | 'dead' | 'error'

export interface KernelInfo {
  status: KernelStatus
  python?: string
  language?: string
  version?: string
  message?: string
  /** Cells run on this kernel since it (re)started; 0 means a fresh kernel. */
  runs?: number
}

/** Full notebook snapshot sent when a view connects. */
export interface WireNotebook {
  path: string
  /** Document revision; every push event carries the new one. */
  rev: number
  cells: WireCell[]
  metadata: JsonObject
  kernel: KernelInfo
  /** Edits not yet written to disk. */
  dirty: boolean
  /** The file changed on disk while the document had unsaved edits. */
  conflict: boolean
  /** Read-only view (the session policy forbids writes). */
  readOnly: boolean
  /** Python chosen for this notebook (empty = discovered default). */
  python: string
}

/** Server-sent events pushed to every connected view of one notebook. */
export type NotebookEvent =
  | { t: 'snap'; nb: WireNotebook }
  | { t: 'cell'; rev: number; index: number; cell: WireCell; by?: string }
  | { t: 'order'; rev: number; ids: string[]; by?: string }
  /** `append` merges `output.text` into the cell's last stream output of the same name. */
  | { t: 'out'; rev: number; id: string; output: JsonObject; append?: boolean }
  | { t: 'clear'; rev: number; id: string }
  | { t: 'run'; rev: number; id: string; run: 'queued' | 'running' | null; execution_count?: number | null }
  | { t: 'kernel'; kernel: KernelInfo }
  | { t: 'meta'; rev: number; metadata: JsonObject; python: string }
  | { t: 'save'; dirty: boolean; conflict: boolean }

export interface InterpreterOption {
  python: string
  label: string
  kind: 'project' | 'env' | 'config' | 'venv' | 'conda' | 'system' | 'uv'
  /** Has ipykernel + jupyter_client installed (checked passively from the filesystem; undefined = unknown). */
  ready?: boolean
  /** May the plugin start it without asking? False for anything inside the workspace until the user picks it. */
  trusted?: boolean
  /** Lives inside the session workspace. */
  workspace?: boolean
}

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Edit operations accepted by the host (UI and agent share them). */
export type EditOp =
  | { op: 'insert'; after?: string | number; cell_type?: 'code' | 'markdown' | 'raw'; source?: string; id?: string }
  | { op: 'source'; id: string; source: string }
  | { op: 'type'; id: string; cell_type: 'code' | 'markdown' | 'raw' }
  | { op: 'delete'; id: string }
  | { op: 'move'; id: string; to: number }
  | { op: 'clear'; id?: string }

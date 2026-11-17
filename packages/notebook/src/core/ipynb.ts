/**
 * .ipynb reading and writing without nbformat. Unknown keys (cell `attachments`, vendor
 * extensions, output metadata) survive a round trip, cells and outputs the user did not touch are
 * written back exactly as read, and the output matches what nbformat.write produces
 * (indent 1, sorted keys, text stored as lines) so files do not churn in git.
 * Reimplements the idea of beihzb/dsh-notebook's Python layer (MIT) in TypeScript.
 */
import type { JsonObject } from './types.ts'

export const NBFORMAT = 4
export const NBFORMAT_MINOR = 5

/** A cell as the host keeps it: the wire fields plus what is needed to write it back faithfully. */
export interface DocCell {
  id: string
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  execution_count: number | null
  outputs: JsonObject[]
  metadata: JsonObject
  rev: number
  /** The cell exactly as read from disk (undefined for cells created here). */
  raw?: JsonObject
  /** Outputs changed since `raw`; unchanged outputs are written from `raw`. */
  outputsDirty: boolean
  /** Unknown keys (e.g. markdown attachments). */
  extras: JsonObject
}

export interface ParsedNotebook {
  cells: DocCell[]
  metadata: JsonObject
  minor: number
  /** Unknown top-level keys. */
  extras: JsonObject
}

const CELL_KEYS = new Set(['id', 'cell_type', 'source', 'outputs', 'metadata', 'execution_count'])
const TOP_KEYS = new Set(['cells', 'metadata', 'nbformat', 'nbformat_minor'])

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Multiline field: nbformat stores a string or a list of lines. */
export function joinLines(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => (typeof part === 'string' ? part : String(part))).join('')
  return ''
}

/** Python's `str.splitlines(True)` for the common separators; the empty string gives no lines. */
export function splitLines(text: string): string[] {
  return text === '' ? [] : (text.match(/[^\n]*\n|[^\n]+/g) ?? [])
}

const isTextMime = (mime: string): boolean => mime.startsWith('text/') || mime === 'application/javascript' || mime === 'image/svg+xml'

function normalizeOutput(output: JsonObject): JsonObject {
  const next: JsonObject = { ...output }
  if (output.output_type === 'stream') next.text = joinLines(output.text)
  const data = output.data
  if (isObject(data)) {
    const joined: JsonObject = {}
    for (const [mime, value] of Object.entries(data)) joined[mime] = isTextMime(mime) && Array.isArray(value) ? joinLines(value) : value
    next.data = joined
  }
  return next
}

function denormalizeOutput(output: JsonObject): JsonObject {
  const next: JsonObject = { ...output }
  if (output.output_type === 'stream') next.text = splitLines(joinLines(output.text))
  const data = output.data
  if (isObject(data)) {
    const split: JsonObject = {}
    for (const [mime, value] of Object.entries(data)) split[mime] = isTextMime(mime) && typeof value === 'string' ? splitLines(value) : value
    next.data = split
  }
  if (output.output_type === 'error' && Array.isArray(output.traceback)) next.traceback = output.traceback.map((line) => joinLines(line))
  if (output.output_type === 'update_display_data') next.output_type = 'display_data'
  return next
}

/** New 8-hex-digit id (nbformat 4.5 allows 1-64 of [a-zA-Z0-9-_]). */
export function newCellId(taken?: Set<string>): string {
  for (;;) {
    const id = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    if (taken === undefined || !taken.has(id)) return id
  }
}

/** Parse notebook JSON text. */
export function parseNotebook(text: string): ParsedNotebook | { error: string } {
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { error: 'The file is not valid JSON.' }
  }
  if (!isObject(json)) return { error: 'The file is not a notebook (expected a JSON object).' }
  const format = typeof json.nbformat === 'number' ? json.nbformat : undefined
  if (format !== NBFORMAT) {
    return { error: format === undefined ? 'The file has no nbformat field.' : `Only nbformat 4 notebooks are supported (found ${format}). Convert it with \`jupyter nbconvert --to notebook --nbformat 4\`.` }
  }
  const minor = typeof json.nbformat_minor === 'number' ? json.nbformat_minor : NBFORMAT_MINOR
  const taken = new Set<string>()
  const cells: DocCell[] = []
  for (const raw of Array.isArray(json.cells) ? json.cells : []) {
    if (!isObject(raw)) continue
    const type = raw.cell_type
    if (type !== 'code' && type !== 'markdown' && type !== 'raw') continue
    let id = typeof raw.id === 'string' && raw.id !== '' && !taken.has(raw.id) ? raw.id : ''
    if (id === '') id = newCellId(taken)
    taken.add(id)
    const extras: JsonObject = {}
    for (const [key, value] of Object.entries(raw)) if (!CELL_KEYS.has(key)) extras[key] = value
    cells.push({
      id,
      cell_type: type,
      source: joinLines(raw.source),
      execution_count: typeof raw.execution_count === 'number' ? raw.execution_count : null,
      outputs: type === 'code' && Array.isArray(raw.outputs) ? raw.outputs.filter(isObject).map(normalizeOutput) : [],
      metadata: isObject(raw.metadata) ? raw.metadata : {},
      rev: 1,
      raw: raw.id === id ? raw : { ...raw, id },
      outputsDirty: false,
      extras,
    })
  }
  const extras: JsonObject = {}
  for (const [key, value] of Object.entries(json)) if (!TOP_KEYS.has(key)) extras[key] = value
  return { cells, metadata: isObject(json.metadata) ? json.metadata : {}, minor, extras }
}

/** Recursively sort object keys (Python `sort_keys=True`). */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isObject(value)) {
    const out: JsonObject = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

function serializeCell(cell: DocCell): JsonObject {
  const raw = cell.raw
  const out: JsonObject = { ...cell.extras, id: cell.id, cell_type: cell.cell_type, metadata: cell.metadata }
  out.source = raw !== undefined && joinLines(raw.source) === cell.source && Array.isArray(raw.source) ? raw.source : splitLines(cell.source)
  if (cell.cell_type === 'code') {
    out.execution_count = cell.execution_count
    out.outputs = !cell.outputsDirty && raw !== undefined && Array.isArray(raw.outputs) ? raw.outputs : cell.outputs.map(denormalizeOutput)
  }
  return out
}

/** Serialize to nbformat-compatible JSON text. */
export function serializeNotebook(nb: { cells: DocCell[]; metadata: JsonObject; minor: number; extras: JsonObject }): string {
  const minor = Math.max(nb.minor, NBFORMAT_MINOR)
  const doc = { ...nb.extras, cells: nb.cells.map(serializeCell), metadata: nb.metadata, nbformat: NBFORMAT, nbformat_minor: minor }
  return JSON.stringify(sortKeys(doc), null, 1) + '\n'
}

/** A fresh notebook with one empty code cell. */
export function emptyNotebook(): ParsedNotebook {
  return {
    cells: [{ id: newCellId(), cell_type: 'code', source: '', execution_count: null, outputs: [], metadata: {}, rev: 1, outputsDirty: true, extras: {} }],
    metadata: { kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
    minor: NBFORMAT_MINOR,
    extras: {},
  }
}

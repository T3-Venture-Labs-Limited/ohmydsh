// Secret redaction + size capping for everything that leaves the process. Ported from pi-observability-plugin
// (src/telemetry.ts): copy-only, never mutates the request or tool result it is given.
import { createHash } from 'node:crypto'

const REDACTED = '[redacted-secret]'
const SECRET_FIELD =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|secret[-_]?key|secret|password|passwd|client[-_]?secret|(?:api|auth|access|refresh|id)[-_]?token|token|credentials|connection[-_]?string|database[-_]?url|private[-_]?key|encrypted_content)$/i

export type Sanitized = boolean | number | string | null | undefined | Sanitized[] | { [key: string]: Sanitized }

/**
 * Patterns applied to every string that leaves the process, in order. The first block is ported from
 * pi-observability-plugin; LF-1 added the vendor-token, JWT, PEM and generic `token: value` rules (the set mirrors
 * dsh-skill-studio's redactor, plus Composio user keys).
 */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // PEM private keys, including a truncated block (capture cuts long text, so an END line may be missing).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted-private-key]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`],
  [/\b[sp]k-lf-[\w-]+\b/g, '[redacted-langfuse-secret]'],
  [/\b(?:sk-(?:proj-|ant-)?[\w-]{8,}|pk-lf-[\w-]+|gh[pousr]_\w{16,})\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\b(?:glpat|glptt|glrt)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bxapp-\d-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\buak_[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  [/([?&](?:api[_-]?key|token|access_token|signature|x-amz-signature)=)[^&\s"'<>]+/gi, `$1${REDACTED}`],
  [/(\b[a-z][a-z\d+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[redacted-credentials]@'],
  // NAME_KEY=value style assignments: any name ending or containing KEY/SECRET/PASSWORD/TOKEN/CREDENTIAL.
  [/(\b[A-Z][A-Z0-9_]*(?:API[_-]?KEY|KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIALS?)[A-Z0-9_]*["']?\s*[:=]\s*["']?)[^\s"'`,;}]+/g, `$1${REDACTED}`],
  [/(\b[A-Z_]*(?:API[_-]?KEY|SECRET|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN)["']?\s*[:=]\s*["']?)[^\s"'`,;}]+/gi, `$1${REDACTED}`],
  // Plain `token: abcdefgh12345678`, `"password": "..."`, `secret=...`, `authorization: ...` (JSON or YAML or env style).
  [/(\b(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|password|passwd|pwd|authorization|credentials?)["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"'`,;}]{6,}/gi, `$1${REDACTED}`],
]

/** Redact one string with the shared secret patterns plus literal secrets (env values, configured keys). */
export function redactString(input: string, secrets: readonly string[] = [], omitBinary = true): string {
  let text = input
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join(REDACTED)
  if (omitBinary) text = text.replace(/data:[^;,\s]{1,100};base64,[A-Za-z0-9+/\s]+=*/g, '[binary data omitted]')
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement)
  return text
}

/** Deep copy with redaction; circular guard and depth limit as in the pi plugin. */
export function sanitize(value: unknown, secrets: readonly string[] = [], ancestors: object[] = [], omitBinary = true): Sanitized {
  if (typeof value === 'string') return redactString(value, secrets, omitBinary)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value !== 'object') return undefined
  if (ancestors.includes(value)) return '[circular-ref]'
  if (ancestors.length >= 80) return '[depth limit]'
  const next = [...ancestors, value]
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets, next, omitBinary))
  const record = value as Record<string, unknown>
  if (omitBinary && record['type'] === 'image' && (record['data'] !== undefined || record['source'] !== undefined)) {
    return { type: 'image', mimeType: sanitize(record['mimeType'], secrets, next, omitBinary), omitted: true }
  }
  const fields: { [key: string]: Sanitized } = {}
  for (const [key, item] of Object.entries(record)) {
    const inlineBinary =
      omitBinary &&
      (key === 'file_data' ||
        (key === 'data' && (record['mimeType'] !== undefined || record['mime_type'] !== undefined || record['media_type'] !== undefined || record['format'] !== undefined || record['type'] === 'base64')))
    // defineProperty keeps a key literally named "__proto__" as plain data.
    Object.defineProperty(fields, key, {
      value: SECRET_FIELD.test(key) ? REDACTED : inlineBinary ? '[binary omitted]' : sanitize(item, secrets, next, omitBinary),
      enumerable: true, writable: true, configurable: true,
    })
  }
  return fields
}

/** Env values that look like secrets (names ending KEY/SECRET/PASSWORD/TOKEN), scrubbed as literals. */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /(?:KEY|SECRET|PASSWORD|TOKEN)$/.test(key) && (value?.length ?? 0) >= 8)
    .map(([, value]) => value as string)
}

export interface Captured { value: unknown; truncated: boolean; originalChars: number; sha256?: string }

/** Sanitize then cap the serialized size with a head+tail excerpt (pi's captureProviderPayload rule). */
export function capture(value: unknown, secrets: readonly string[], maxChars: number): Captured {
  const clean = sanitize(value, secrets)
  const serialized = typeof clean === 'string' ? clean : (JSON.stringify(clean) ?? 'null')
  if (serialized.length <= maxChars) return { value: clean, truncated: false, originalChars: serialized.length }
  const half = Math.floor(maxChars / 2)
  return {
    value: { truncated: true, head: serialized.slice(0, half), tail: serialized.slice(-half) },
    truncated: true,
    originalChars: serialized.length,
    sha256: createHash('sha256').update(serialized).digest('hex'),
  }
}

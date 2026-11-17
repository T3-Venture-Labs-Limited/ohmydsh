// Best-effort secret redaction applied to every transcript sent to a model and to every proposed skill body.
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[redacted key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, '[redacted key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted token]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[redacted token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted aws key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[redacted key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, '$1[redacted]@'],
  [/\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, '$1=[redacted]'],
  [/\b((?:api[_-]?key|secret|token|password|passwd|authorization)["']?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{8,})/gi, '$1[redacted]'],
]

export function redact(text: string): string {
  let out = text
  for (const [re, to] of PATTERNS) out = out.replace(re, to)
  return out
}

/** True when `redact` would change the text: used to block secrets in proposed skill content. */
export function containsSecret(text: string): boolean {
  return redact(text) !== text
}

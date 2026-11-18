// Trusted hosts: the addresses DSH accepts browser connections from besides loopback (for example this machine's
// Tailscale name behind `tailscale serve`). They are written into the profile, not passed as `--trusted-host` at
// start, because a service that starts at boot runs before Tailscale is up and would otherwise come up without
// them: the page loads but every live connection is refused (403), and a phone shows "Reconnecting" forever.

const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/

export function normalizeHost(value) {
  const h = String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
  return HOST_RE.test(h) ? h : null
}

/** This machine's Tailscale names (full MagicDNS name and short name), or [] when Tailscale is not running. */
export function tailnetHosts(ctx) {
  const r = ctx.run('tailscale', ['status', '--json'], { env: ctx.env, timeoutMs: 5000 })
  if (r.error || r.status !== 0) return []
  let status
  try { status = JSON.parse(r.stdout) } catch { return [] }
  const dns = normalizeHost(status?.Self?.DNSName)
  if (!dns) return []
  return dns.includes('.') ? [dns, dns.split('.')[0]] : [dns]
}

/** Merge host lists, dropping invalid entries and duplicates, keeping first-seen order. */
export function mergeHosts(...lists) {
  const out = []
  for (const list of lists) for (const v of list ?? []) {
    const h = normalizeHost(v)
    if (h && !out.includes(h)) out.push(h)
  }
  return out
}

/** The patch row that makes DSH trust `hosts` on every start, on top of any `--trusted-host` given at launch. */
export function trustedHostsRow(hosts) {
  if (hosts.length === 0) return ''
  const list = hosts.map((h) => JSON.stringify(h)).join(', ')
  return [
    '# Trusted hosts (written by omd from this machine\'s Tailscale name and --trusted-host): DSH accepts browser',
    '# connections from these from the first second after boot. Change them with `omd setup --trusted-host a,b`.',
    '- id: connection',
    '  name: \'@deepseek-ai/dsh-client-connection\'',
    '  config:',
    `    trustedHosts: !!js '[${list}, ...ctx.webStartup.trustedHosts]'`,
  ].join('\n')
}

// Tiny argument parser: --flag, --key value, --key=value, positionals.
const BOOLEAN = new Set(['dev', 'force', 'dry-run', 'boot-check', 'no-dsh-install', 'json', 'yes', 'help', 'version'])

export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (!a.startsWith('--')) { positional.push(a); continue }
    const eq = a.indexOf('=')
    const key = (eq === -1 ? a.slice(2) : a.slice(2, eq))
    if (eq !== -1) flags[key] = a.slice(eq + 1)
    else if (BOOLEAN.has(key)) flags[key] = true
    else { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) flags[key] = true; else { flags[key] = v; i++ } }
  }
  return { flags, positional }
}

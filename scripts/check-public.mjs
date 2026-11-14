// Fails unless the files the host serves from public/ exist (they are read at request time, so a missing file only
// shows up as a 500 on /m). Run by `pnpm run build`.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const missing = ['public/m/events.js', 'public/m/app.js', 'public/m/app.css'].filter((f) => !existsSync(resolve(root, f)))
if (missing.length > 0) { console.error('check-public: FAILED, missing ' + missing.join(', ')); process.exit(1) }
console.log('check-public: ok')

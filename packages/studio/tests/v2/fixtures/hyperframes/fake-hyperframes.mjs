#!/usr/bin/env node
// Minimal stand-in for the hyperframes CLI: --version, init <name> (creates index.html), preview <dir> --port N (serves /__hyperframes_config).
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('0.9.41'); process.exit(0) }
if (args[0] === 'init') {
  if (process.env.FAKE_HF_INIT_FAIL === '1') { console.error('boom'); process.exit(3) }
  const dir = join(process.cwd(), args[1]); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<html></html>'); writeFileSync(join(dir, 'init-args.json'), JSON.stringify(args))
  process.exit(0)
}
if (args[0] === 'preview') {
  const port = Number(args[args.indexOf('--port') + 1])
  if (process.env.FAKE_HF_PREVIEW_FAIL === '1') { console.error('port busy'); process.exit(4) }
  createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/__hyperframes_config' ? JSON.stringify({ isHyperframes: true, pid: process.pid }) : '{}') }).listen(port, '127.0.0.1')
  setInterval(() => {}, 1000)
}

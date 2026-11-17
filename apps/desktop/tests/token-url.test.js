'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseAnnouncement, redact } = require('../src/token-url')

test('reads the URL line dsh web prints', () => {
  const r = parseAnnouncement('dsh web: http://127.0.0.1:43080/?token=abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1')
  assert.equal(r.origin, 'http://127.0.0.1:43080'); assert.match(r.url, /token=abcDEF/)
})
test('ignores every other line and anything that is not a local DSH URL with a token', () => {
  for (const l of ['dsh web: opening the default browser', 'hello', 'dsh web: http://127.0.0.1:1/', 'dsh web: https://evil.example/?token=abcdefghijklmnop', 'dsh web: file:///etc/passwd?token=x']) assert.equal(parseAnnouncement(l), undefined, l)
  assert.ok(parseAnnouncement('dsh web: https://laptop.tail1.ts.net/?token=abcdefghijklmnop'))
})
test('redacts launch tokens and device tokens from log text', () => {
  assert.equal(redact('open http://x/?token=SECRET123&a=1'), 'open http://x/?token=<redacted>&a=1')
  assert.equal(redact('Bearer dsh-dev_abcDEF-_123'), 'Bearer dsh-dev_<redacted>')
})

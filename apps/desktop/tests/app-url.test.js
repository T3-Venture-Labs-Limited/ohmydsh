'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { planOpen, plainUrl, isSignedInUrl, sameOrigin } = require('../src/app-url')

const token = 'http://127.0.0.1:43080/?token=abc_DEF-123'

test('plainUrl: origin plus query, never the token', () => {
  assert.equal(plainUrl(token, 'settings=phone'), 'http://127.0.0.1:43080/?settings=phone')
  assert.equal(plainUrl(token), 'http://127.0.0.1:43080/')
  assert.equal(plainUrl(token, 'settings=phone&token=evil'), 'http://127.0.0.1:43080/?settings=phone')
  assert.equal(plainUrl('https://box.tail1234.ts.net:8443/?token=x', 'settings=phone'), 'https://box.tail1234.ts.net:8443/?settings=phone')
})
test('signed-in detection: same origin and no token in the address', () => {
  assert.equal(isSignedInUrl('http://127.0.0.1:43080/', token), true)
  assert.equal(isSignedInUrl('http://127.0.0.1:43080/sessions/1?x=1', token), true)
  assert.equal(isSignedInUrl(token, token), false)
  assert.equal(isSignedInUrl('http://127.0.0.1:43081/', token), false)
  assert.equal(isSignedInUrl('file:///x/loading.html', token), false)
  assert.equal(isSignedInUrl('', token), false)
  assert.equal(sameOrigin('about:blank', 'about:blank'), false)
})
test('already signed in: navigate straight to /?settings=phone without the token', () => {
  const p = planOpen({ tokenUrl: token, currentUrl: 'http://127.0.0.1:43080/', signedIn: true, query: 'settings=phone' })
  assert.deepEqual(p, { then: 'http://127.0.0.1:43080/?settings=phone' })
  assert.doesNotMatch(JSON.stringify(p), /token/)
})
test('not signed in yet: token URL first, then /?settings=phone', () => {
  for (const currentUrl of ['file:///app/loading.html', '', 'http://127.0.0.1:43080/']) {
    assert.deepEqual(planOpen({ tokenUrl: token, currentUrl, signedIn: false, query: 'settings=phone' }), { load: token, then: 'http://127.0.0.1:43080/?settings=phone' })
  }
  // "signed in" from a previous DSH run but the window sits on the loading page (DSH restarted): sign in again
  assert.deepEqual(planOpen({ tokenUrl: token, currentUrl: 'file:///app/loading.html', signedIn: true, query: 'settings=phone' }).load, token)
})
test('plain open: nothing to do when already signed in, otherwise the token URL', () => {
  assert.deepEqual(planOpen({ tokenUrl: token, currentUrl: 'http://127.0.0.1:43080/', signedIn: true }), {})
  assert.deepEqual(planOpen({ tokenUrl: token, currentUrl: 'file:///x', signedIn: false }), { load: token })
})

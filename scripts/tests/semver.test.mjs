import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compare, isAlpha, nextPatch, satisfies } from '../lib/semver.mjs'

test('prerelease tags order numerically per identifier, and a release beats its prereleases', () => {
  const order = ['0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.3', '0.2.2-rc.5', '0.2.2-rc.10', '0.2.2', '0.2.10', '0.10.0', '1.0.0']
  for (let i = 0; i < order.length - 1; i++) assert.equal(compare(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`)
  assert.equal(compare('1.2.3', '1.2.3'), 0)
  assert.equal(compare('0.2.2-rc.5', '0.2.2-rc.3'), 1)
  assert.throws(() => compare('latest', '1.0.0'))
})

test('isAlpha and nextPatch', () => {
  assert.equal(isAlpha('0.2.2-alpha.3'), true)
  assert.equal(isAlpha('0.2.2-rc.5'), false)
  assert.equal(isAlpha('0.2.2'), false)
  assert.equal(nextPatch('0.1.3'), '0.1.4')
  assert.equal(nextPatch('0.1.9'), '0.1.10')
})

test('satisfies handles the range our packages use', () => {
  const range = '>=0.2.2-rc.1 <0.3.0-0'
  assert.equal(satisfies('0.2.2-rc.5', range), true)
  assert.equal(satisfies('0.2.2', range), true)
  assert.equal(satisfies('0.2.2-rc.0', range), false)
  assert.equal(satisfies('0.3.0', range), false)
  assert.equal(satisfies('0.3.0-rc.1', range), false)
})

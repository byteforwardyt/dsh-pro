import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseRange } from '../lib/raw.js'
import { contentTypeFor, isRenderable } from '../lib/mime.js'

test('a plain range is inclusive on both ends', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
})

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 })
})

test('a suffix range counts back from the end', () => {
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
})

test('a suffix longer than the file yields the whole file', () => {
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 })
})

test('an end past the file is clamped, because clients guess', () => {
  assert.deepEqual(parseRange('bytes=900-99999', 1000), { start: 900, end: 999 })
})

test('a start past the end of the file is unsatisfiable, not absent', () => {
  // Returning null here would silently serve the whole file for a 416 case.
  assert.deepEqual(parseRange('bytes=2000-', 1000), { unsatisfiable: true })
})

test('an inverted range is unsatisfiable', () => {
  assert.deepEqual(parseRange('bytes=500-100', 1000), { unsatisfiable: true })
})

test('absent or malformed headers mean no range at all', () => {
  assert.equal(parseRange(undefined, 1000), null)
  assert.equal(parseRange('', 1000), null)
  assert.equal(parseRange('bytes=-', 1000), null)
  assert.equal(parseRange('items=0-10', 1000), null)
  // Multi-range is legal HTTP that this route does not implement; answering the
  // whole file is correct, answering the first part as if it were all is not.
  assert.equal(parseRange('bytes=0-10,20-30', 1000), null)
})

test('media types are named exactly, because the browser will not sniff them', () => {
  assert.equal(contentTypeFor('a.mp3'), 'audio/mpeg')
  assert.equal(contentTypeFor('a.mp4'), 'video/mp4')
  assert.equal(contentTypeFor('a.MOV'), 'video/quicktime')
  assert.equal(contentTypeFor('a.pdf'), 'application/pdf')
  assert.equal(contentTypeFor('a.png'), 'image/png')
})

test('an unknown extension is octet-stream rather than a guess', () => {
  assert.equal(contentTypeFor('a.weird'), 'application/octet-stream')
  assert.equal(contentTypeFor('Makefile'), 'application/octet-stream')
})

test('only media and pdf are renderable — workspace html never is', () => {
  assert.ok(isRenderable('video/mp4'))
  assert.ok(isRenderable('audio/mpeg'))
  assert.ok(isRenderable('image/png'))
  assert.ok(isRenderable('application/pdf'))
  // A page the agent just wrote must not execute on this origin.
  assert.equal(isRenderable('text/html; charset=utf-8'), false)
  assert.equal(isRenderable('image/svg+xml'), true)
})

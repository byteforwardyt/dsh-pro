import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let definition
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: (value) => { definition = value } } },
})
const media = definition.factory(() => ({ createElement: () => {} }))
const root = '/Users/someone/Desktop/Example'

test('chat media scanner skips folder paths and deduplicates relative and absolute image links', () => {
  const reply = [
    '`/Users/someone/Desktop/Example/gallery/`',
    '![Active combat](gallery/screenshots/01-active-combat.png)',
    '`/Users/someone/Desktop/Example/gallery/screenshots/01-active-combat.png`',
    '![Power](gallery/screenshots/02-unlocked-power.png)',
  ].join('\n')
  const references = media.references(reply)
  assert.equal(references.includes('/Users/someone/Desktop/Example/gallery/'), false)
  assert.deepEqual(Array.from(media.resolvedMediaPaths(references, root)), [
    `${root}/gallery/screenshots/01-active-combat.png`,
    `${root}/gallery/screenshots/02-unlocked-power.png`,
  ])
})

test('turn selector excludes non-media deliverables and respects event sequence', () => {
  const owner = {
    seq: 10,
    turn: { data: new Map([
      ['desktop-media', { paths: [{ path: 'screenshots/a.png', seq: 2 }] }],
      ['deliverables', { produced: [
        { path: 'game/', seq: 3 },
        { path: 'src/main.js', seq: 4 },
        { path: 'screenshots/b.jpg', seq: 11 },
      ] }],
    ]) },
  }
  assert.deepEqual(Array.from(media.selectMedia(owner)), ['screenshots/a.png'])
  assert.deepEqual(Array.from(media.resolvedMediaPaths(media.selectMedia(owner), root)), [`${root}/screenshots/a.png`])
})

test('relative paths normalize without creating duplicate cards', () => {
  assert.deepEqual(Array.from(media.resolvedMediaPaths([
    './gallery/screenshots/a.png',
    `${root}/gallery/screenshots/a.png`,
    'gallery/./screenshots/b.jpg',
  ], root)), [`${root}/gallery/screenshots/a.png`, `${root}/gallery/screenshots/b.jpg`])
  assert.equal(media.absoluteMediaPath('screenshots/a.png', undefined), null)
})

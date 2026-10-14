import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../plugins/client-ui-theme-holo/lib/client.js', import.meta.url), 'utf8')

function mountTheme () {
  let plugin, listener
  let entries = ['chat', 'trajectory', 'preview', 'files'].map(id => ({ options: { id, label: () => { throw new Error('Icons must not depend on translated labels') } } }))
  const styles = []
  const cleanup = []
  const document = {
    body: { setAttribute () {}, removeAttribute () {} },
    head: { appendChild: style => styles.push(style) },
    createElement: () => ({ textContent: '', remove () { this.removed = true } }),
  }
  const window = { __ModuleLoader__: { load: definition => { plugin = definition.factory(() => ({})) } } }
  vm.runInNewContext(source, { window, document })
  plugin.apply({
    effect (callback) { const dispose = callback(); cleanup.push(dispose); return dispose },
    slots: {
      inject (_name, callback) { callback() },
      register () {},
      entries: () => entries,
      subscribe (_name, callback) { listener = callback; return () => { listener = null } },
    },
  })
  const style = styles.find(item => item.id === 'dshd-view-icons-style')
  const icons = () => new Map([...style.textContent.matchAll(/nth-child\((\d+)\).*?data:image\/svg\+xml,([^"\n]+)/g)].map(match => [Number(match[1]), decodeURIComponent(match[2])]))
  return {
    style, icons,
    update (ids) { entries = ids.map(id => ({ options: { id } })); listener() },
    unmount () { for (const dispose of cleanup.reverse()) dispose() },
    subscribed: () => listener !== null,
  }
}

test('view icons track live slot insertion and ordering without using localized labels', () => {
  const theme = mountTheme()
  const original = theme.icons()
  assert.equal(original.size, 4)
  assert.equal(new Set(original.values()).size, 4, 'each view needs a distinct SVG')
  theme.update(['extension', 'files', undefined, 'chat', 'preview', 'trajectory'])
  const updated = theme.icons()
  assert.equal(updated.size, 4)
  assert.equal(updated.has(1), false, 'an unknown view must not inherit the Chat icon')
  assert.equal(updated.get(2), original.get(4))
  assert.equal(updated.get(3), original.get(1))
  assert.equal(updated.get(4), original.get(3))
  assert.equal(updated.get(5), original.get(2))
  theme.unmount()
})

test('removed views lose their icon rules and plugin teardown removes the subscription and style', () => {
  const theme = mountTheme()
  theme.update(['chat', '__proto__'])
  assert.equal(theme.icons().size, 1)
  theme.unmount()
  assert.equal(theme.style.removed, true)
  assert.equal(theme.subscribed(), false)
})

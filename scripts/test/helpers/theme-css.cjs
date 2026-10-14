const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {loadClient} = require('./client-harness.cjs')

/** The stylesheet the theme plugin really injects, not a re-read of its source. */
function themeCSS () {
  let css = ''
  const document = {
    head: {appendChild (node) { if (node.id === 'dshd-desktop-theme-style') css = node.textContent }},
    body: {setAttribute () {}, removeAttribute () {}},
    createElement: () => ({}),
    addEventListener () {}, removeEventListener () {},
  }
  loadClient('client-ui-theme-holo', () => {}, {globals: {document}})
  assert.notEqual(css, '', 'the theme no longer injects its stylesheet under the expected id')
  return css
}

/** The shipped conversation bundle, located the way scripts/bump-check.cjs does. */
function conversationBundle (pkg = 'dsh-client-ui-conversation') {
  const modules = path.join(__dirname, '..', '..', '..', 'node_modules', '.pnpm')
  for (const dir of fs.readdirSync(modules)) {
    if (!dir.startsWith('@deepseek-ai+')) continue
    const file = path.join(modules, dir, 'node_modules', '@deepseek-ai', pkg, 'lib', 'client.js')
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  }
  throw new Error('@deepseek-ai/dsh-client-ui-conversation not installed — run an install first')
}

module.exports = {themeCSS, conversationBundle}

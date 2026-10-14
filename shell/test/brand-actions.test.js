import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../plugins/client-ui-brand/lib/client.js', import.meta.url), 'utf8')

// A DOM small enough to read and real enough to be wrong the way the browser
// is: elements in document order, duplicate accessible names allowed, and a
// selector engine that has to understand the selectors the actions actually
// write. The previous fixture returned one flat array for any selector
// containing "button", so document order and duplicate labels could not be
// expressed - which is exactly the shape of the bugs this file now covers.

function element (tag, { className, attrs = {}, text = '', children = [] } = {}) {
  const attributes = { ...attrs }
  if (className !== undefined) attributes.class = className
  return {
    tagName: tag.toUpperCase(),
    attributes,
    children,
    clicks: 0,
    focused: 0,
    get textContent () { return text + children.map((child) => child.textContent).join('') },
    set textContent (value) { text = value; children = []; },
    getAttribute (name) { return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null },
    setAttribute (name, value) { this.attributes[name] = value },
    querySelector (selector) { return queryAll(this, selector)[0] ?? null },
    querySelectorAll (selector) { return queryAll(this, selector) },
    click () { this.clicks++; this.attributes['aria-expanded'] = 'true' },
    focus () { this.focused++ },
  }
}

/** One compound selector: tag, .class, [attr], [attr="v"], [attr~="v"], [attr*="v"]. */
function matchesCompound (node, compound) {
  const tokens = compound.match(/^[a-z]+|\.[A-Za-z0-9_-]+|\[[^\]]+\]/g) ?? []
  return tokens.every((token) => {
    if (token.startsWith('.')) return (node.getAttribute('class') ?? '').split(/\s+/).includes(token.slice(1))
    if (!token.startsWith('[')) return node.tagName === token.toUpperCase()
    const body = token.slice(1, -1)
    const test = body.match(/^([\w-]+)(?:([~*]?)="([^"]*)")?$/)
    assert.ok(test, `the fixture cannot parse the selector ${token} - teach it rather than working around it`)
    const value = node.getAttribute(test[1])
    if (value === null) return false
    if (test[3] === undefined) return true
    if (test[2] === '~') return value.split(/\s+/).includes(test[3])
    if (test[2] === '*') return value.includes(test[3])
    return value === test[3]
  })
}

function descendants (root, chain = []) {
  return root.children.flatMap((child) => [{ node: child, chain }, ...descendants(child, [...chain, child])])
}

// Descendant combinators only, split on spaces. No selector in the plugin puts
// a space inside an attribute value; the assert in matchesCompound catches it
// if one ever does.
function queryAll (root, selector) {
  const parts = selector.trim().split(/\s+/)
  const target = parts.at(-1)
  const required = parts.slice(0, -1)
  return descendants(root).filter(({ node, chain }) => {
    if (!matchesCompound(node, target)) return false
    let matched = 0
    for (const ancestor of chain) {
      if (matched < required.length && matchesCompound(ancestor, required[matched])) matched++
    }
    return matched === required.length
  }).map(({ node }) => node)
}

const EN = { chat: 'Chat', trajectory: 'Trajectory', preview: 'Preview', files: 'Files' }
const RING = ['chat', 'trajectory', 'preview', 'files']

/**
 * Build the page and load the shipped browser module against it.
 *
 * home: the blank session, where upstream's header renders no children at all.
 * That is the state the workspace-tools dialog used to win in.
 */
function mountBrand ({
  home = false, views = RING, labels = EN, title = 'A session',
  settingsPresent = true, sidebarToggle = true, sessionLog = true, terminalPresent = true,
  composer = true, filesEditor = false, bridge = true,
} = {}) {
  const newSession = element('button', {
    className: 'hHd-Xa_newSession',
    // Translated upstream, which is why the action must not match on it.
    attrs: { 'aria-label': labels === EN ? 'New session' : '新建会话' },
  })
  const settings = element('button', { className: 'VOzbGW_trigger', attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, text: 'Settings' })
  const workspaceTools = element('button', { className: 'dshd-tools-trigger', text: 'Workspace tools', attrs: { 'aria-haspopup': 'dialog' } })
  const sidebar = element('div', { children: [newSession, ...(settingsPresent ? [settings] : []), workspaceTools] })

  const crumb = element('button', { className: 'wSkVaW_crumb', text: title })
  const tabs = views.map((id) => element('button', { className: 'wSkVaW_tab', attrs: { role: 'tab' }, text: labels[id] ?? id }))
  // Upstream only renders the tablist when more than one view is registered.
  const strip = views.length > 1
    ? [element('div', { className: 'wSkVaW_tabs', attrs: { role: 'tablist' }, children: tabs })]
    : []
  const toggle = element('button', { className: 'dshd-inspector-toggle', attrs: { 'aria-label': 'Session sidebar' }, text: 'Sidebar' })
  const logButton = element('button', { className: 'nL4_yW_moreButton', text: 'More actions' })
  const terminalToggle = element('button', { attrs: { 'data-dshd-terminal-toggle': '' }, text: 'Terminal' })
  const utilities = element('div', { className: 'wSkVaW_headerUtilities',
    children: [...(sessionLog ? [logButton] : []), ...(terminalPresent ? [terminalToggle] : [])] })
  const header = element('header', {
    className: 'wSkVaW_header',
    // The blank session renders the header element with no children.
    children: home ? [] : [crumb, ...strip, ...(sidebarToggle ? [toggle] : []), utilities],
  })

  // The view area comes before the composer, so a document-wide editable lookup
  // finds the file editor first.
  const editor = element('textarea', { className: 'dshd-fl-edit', attrs: { 'aria-label': 'Contents of notes.md' } })
  const messageField = element('div', { attrs: { 'data-composer-input': 'true', contenteditable: 'true' } })
  const scrollport = element('div', { attrs: { 'data-input-scroll': 'true' }, children: [messageField] })
  const card = element('div', { className: 'uV2eYG_card', children: composer ? [scrollport] : [] })
  const centre = element('div', { children: [header, ...(filesEditor ? [editor] : []), card] })

  // shell.overlay is an inline sibling after the centre column, not a portal.
  // The workspace-tools dialog is mounted from first paint whether open or not,
  // and it carries tabs named exactly "Files" and "Preview".
  const toolTabs = ['Files', 'Preview'].map((label) => element('button', { className: 'dshd-tools-tab', attrs: { role: 'tab' }, text: label }))
  const dialog = element('dialog', { children: [element('div', { className: 'dshd-tools-tabs', attrs: { role: 'tablist' }, children: toolTabs })] })
  const root = { children: [sidebar, centre, dialog], getAttribute: () => null }

  const document = {
    body: {}, head: { appendChild () {} },
    createElement: () => ({}), getElementById: () => null,
    querySelector: (selector) => queryAll(root, selector)[0] ?? null,
    querySelectorAll: (selector) => queryAll(root, selector),
  }

  // The menu-state publisher is debounced on setTimeout and triggered by the
  // same MutationObserver that tags the settings nav, so both are real here and
  // driven by the test rather than by a clock. bridge:false is the phone
  // browser, where there is no desktop bridge to publish to at all.
  const published = []
  const timers = []
  let mutated = () => {}
  let plugin
  const window = {
    __ModuleLoader__: { load: definition => { plugin = definition.factory(() => ({ createElement: () => null })) } },
  }
  if (bridge) window.__DSH_DESKTOP__ = { publishMenuState: (state) => published.push(state) }
  vm.runInNewContext(source, {
    window,
    document,
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    MutationObserver: class {
      constructor (callback) { mutated = callback }
      observe () {}
    },
  })

  const components = new Map()
  const disposers = []
  let listener = null
  let entries = views.map((id) => ({ options: { id, label: () => { throw new Error('the menu must not read a translated label') } } }))
  plugin.apply({
    effect (callback) { const dispose = callback(); disposers.push(dispose); return dispose },
    slots: {
      inject (_name, callback) {
        const result = callback()
        if (result?.[Symbol.iterator]) for (const _ of result) { /* activate registrations */ }
      },
      register (entry, component) { components.set(entry.name, component) },
      entries: () => entries,
      subscribe (_name, callback) { listener = callback; return () => { listener = null } },
    },
  })
  components.get('sidebar.brand.name')()

  return {
    settings, workspaceTools, newSession, crumb, toggle, logButton, terminalToggle,
    tabs, toolTabs, editor, messageField, published,
    actions: window.__DSHD_ACTIONS__,
    setViews (ids) { entries = ids.map((id) => ({ options: { id } })); listener() },
    /** One DOM change, then the debounce it schedules. */
    mutate () { mutated(); return this.flush() },
    /** Run every pending debounce callback, as the real timer eventually would. */
    flush () { for (const fn of timers.splice(0)) fn(); return published },
    pending: () => timers.length,
    unmount () { for (const dispose of disposers.reverse()) dispose() },
  }
}

test('native Settings action opens settings when workspace tools is the first dialog trigger', () => {
  const { settings, workspaceTools, actions } = mountBrand()
  assert.equal(actions.openSettings(), true)
  assert.equal(settings.clicks, 1)
  assert.equal(workspaceTools.clicks, 0)
  assert.equal(actions.openSettings(), true)
  assert.equal(settings.clicks, 1, 'an already-open settings panel must stay open')
})

test('a missing settings trigger does not open a different dialog', () => {
  const { workspaceTools, actions } = mountBrand({ settingsPresent: false })
  assert.equal(actions.openSettings(), false)
  assert.equal(workspaceTools.clicks, 0)
})

test('New Session is found by class, not by a translated name', () => {
  const page = mountBrand({ labels: { chat: '对话', trajectory: '轨迹', preview: '预览', files: '文件' } })
  assert.equal(page.actions.newSession(), true)
  assert.equal(page.newSession.clicks, 1)
})

test('every view in the ring clicks its own tab', () => {
  const { actions, tabs } = mountBrand()
  for (const [index, id] of RING.entries()) {
    assert.equal(actions.selectView(id), true, id)
    assert.equal(tabs[index].clicks, 1, id)
  }
})

test('the views are reached by position, so a translated header still works', () => {
  // The whole reason the ring is keyed on slot ids: upstream registers
  // label: () => t("view.chat"), and the zh dictionary returns 对话.
  const zh = { chat: '对话', trajectory: '轨迹', preview: '预览', files: '文件' }
  const { actions, tabs, terminalToggle } = mountBrand({ labels: zh })
  assert.equal(actions.selectView('chat'), true)
  assert.equal(tabs[0].clicks, 1)
  assert.equal(actions.selectView('files'), true)
  assert.equal(tabs[3].clicks, 1)
  assert.equal(actions.toggleTerminal(), true)
  assert.equal(terminalToggle.clicks, 1)
})

test('on the home screen no view is selectable and the workspace-tools dialog is left shut', () => {
  // The regression this replaces: with no conversation header, the only control
  // named "Files" was the always-mounted workspace-tools tab, so Cmd+4 opened
  // a modal and reported success.
  const { actions, toolTabs } = mountBrand({ home: true })
  assert.equal(actions.selectView('files'), false)
  assert.equal(actions.selectView('preview'), false)
  for (const tab of toolTabs) assert.equal(tab.clicks, 0, 'the menu opened the workspace-tools dialog')
  const found = actions.probe()
  assert.equal(found.views.files, false, 'probe cannot report a view as present when the header has none')
  assert.equal(found.views.preview, false)
})

test('a session titled exactly like a view does not steal the keystroke', () => {
  // The breadcrumb is a plain button carrying the session title, and it comes
  // before the tab strip in the header.
  const { actions, crumb, tabs } = mountBrand({ title: 'Chat' })
  assert.equal(actions.selectView('chat'), true)
  assert.equal(tabs[0].clicks, 1)
  assert.equal(crumb.clicks, 0, 'the menu navigated to another session instead of switching view')
})

test('turning a view plugin off shifts the ring instead of misfiring', () => {
  const page = mountBrand({ views: ['chat', 'trajectory', 'files'], labels: EN })
  assert.equal(page.actions.selectView('files'), true)
  assert.equal(page.tabs[2].clicks, 1, 'Files must follow its live position, not its position in the full ring')
  assert.equal(page.actions.selectView('terminal'), false)
  assert.equal(page.actions.probe().terminal, true)
})

test('the live ring follows slot changes and is dropped on teardown', () => {
  const page = mountBrand()
  page.setViews(['chat'])
  assert.equal(page.actions.selectView('terminal'), false)
  page.unmount()
  assert.equal(page.actions.selectView('chat'), false, 'the ring outlived the subscription')
})

test('a view outside the published ring is refused rather than clicked', () => {
  const { actions, tabs } = mountBrand()
  assert.equal(actions.selectView('changes'), false)
  assert.equal(actions.selectView('Chat'), false, 'the ring is keyed on ids, and ids are lowercase')
  for (const tab of tabs) assert.equal(tab.clicks, 0)
})

test('the sidebar, Session log, and bottom Terminal are reached inside the header', () => {
  const { actions, toggle, logButton, terminalToggle } = mountBrand()
  assert.equal(actions.toggleSidebar(), true)
  assert.equal(toggle.clicks, 1)
  assert.equal(actions.openSessionLog(), true)
  assert.equal(logButton.clicks, 1)
  assert.equal(actions.toggleTerminal(), true)
  assert.equal(terminalToggle.clicks, 1)
  const bare = mountBrand({ sidebarToggle: false, sessionLog: false, terminalPresent: false })
  assert.equal(bare.actions.toggleSidebar(), false)
  assert.equal(bare.actions.openSessionLog(), false)
  assert.equal(bare.actions.toggleTerminal(), false)
})

test('focusComposer stays in the composer and ignores the file editor', () => {
  const page = mountBrand({ filesEditor: true })
  assert.equal(page.actions.focusComposer(), true)
  assert.equal(page.messageField.focused, 1)
  assert.equal(page.editor.focused, 0, 'the caret landed in a file being edited')
  // Files and Terminal render no composer. Focusing whatever editor those views
  // do mount would be worse than the menu item doing nothing.
  const noComposer = mountBrand({ composer: false, filesEditor: true })
  assert.equal(noComposer.actions.focusComposer(), true)
  assert.equal(noComposer.editor.focused, 0)
  assert.equal(noComposer.actions.probe().composer, true)
})

test('probe reports what the menu can reach and touches nothing', () => {
  const page = mountBrand({ views: ['chat', 'files'], labels: EN })
  const found = page.actions.probe()
  // Every view in the ring is reported, present or not, so a missing tab reads
  // as false rather than as a key that quietly stopped being emitted.
  // Spread first: the probe's object is built inside the vm realm, so strict
  // deepEqual compares two different Object.prototypes and fails on structure
  // that is in fact identical.
  assert.deepEqual({ ...found.views }, { chat: true, trajectory: false, preview: false, files: true })
  assert.equal(found.settings, true)
  assert.equal(found.newSession, true)
  assert.equal(found.sidebar, true)
  assert.equal(found.sessionLog, true)
  assert.equal(found.terminal, true)
  assert.equal(found.composer, true)
  for (const control of [...page.tabs, ...page.toolTabs, page.settings, page.workspaceTools, page.newSession, page.crumb, page.toggle, page.logButton, page.terminalToggle]) {
    assert.equal(control.clicks, 0, 'probe clicked something')
  }
  assert.equal(page.messageField.focused, 0)
})

test('the page publishes its probe to the native menu as soon as it mounts', () => {
  const page = mountBrand()
  // One push at mount, before any DOM change: the menu is built before the page
  // finishes loading, so without this the first state would wait for a mutation.
  assert.equal(page.published.length, 1)
  assert.deepEqual({ ...page.published[0].views }, { chat: true, trajectory: true, preview: true, files: true })
  assert.equal(page.published[0].sessionLog, true)
  assert.equal(page.published[0].terminal, true)
})

test('a DOM change that moves nothing publishes nothing', () => {
  const page = mountBrand()
  // The trigger is a body-wide childList observer and the body mutates on every
  // streamed token, so the signature guard is what stops this from being an IPC
  // message per token for a state that is identical.
  page.mutate()
  page.mutate()
  assert.equal(page.published.length, 1, 'an unchanged probe was published again')
})

test('several changes inside one window schedule one probe, not one each', () => {
  const page = mountBrand()
  // The view-ring effect schedules on mount as well as publishing immediately;
  // drain that before measuring, or its timer counts as one of ours.
  page.flush()
  page.published.length = 0

  page.setViews(['chat'])
  page.setViews(['chat', 'files'])
  assert.equal(page.pending(), 1, 'each change armed its own timer instead of joining the open one')
  page.flush()
  assert.equal(page.published.length, 1, 'the debounce window produced more than one publish')
  assert.deepEqual({ ...page.published[0].views }, { chat: true, trajectory: false, preview: false, files: true })
})

test('the home screen publishes the state that greys the View menu out', () => {
  const page = mountBrand({ home: true })
  const state = page.published.at(-1)
  // The exact case docs/BACKLOG.md item 3 names. Every view false because the
  // conversation header renders no children here, so there is no tab strip to
  // index into - and the composer stays true, because the home screen is where
  // the first prompt is typed.
  assert.deepEqual({ ...state.views }, { chat: false, trajectory: false, preview: false, files: false })
  assert.equal(state.sidebar, false)
  assert.equal(state.sessionLog, false)
  assert.equal(state.terminal, false)
  assert.equal(state.composer, true)
  assert.equal(state.newSession, true)
  assert.equal(state.settings, true)
})

test('turning a view off republishes with that view false', () => {
  const page = mountBrand()
  assert.equal(page.published.at(-1).views.files, true)
  // setViews fires the slot listener, which schedules its own publish - a view
  // plugin unloading need not touch the rest of the body, so the DOM observer
  // alone would miss it.
  page.setViews(['chat', 'trajectory', 'preview'])
  page.flush()
  assert.equal(page.published.length, 2)
  assert.equal(page.published.at(-1).views.files, false)
})

test('no desktop bridge is not an error, and the actions still work', () => {
  // The phone-access browser loads this same module with no preload at all.
  const page = mountBrand({ bridge: false })
  assert.deepEqual(page.published, [])
  assert.equal(page.actions.newSession(), true)
  assert.equal(page.actions.probe().composer, true)
  page.mutate()
  assert.deepEqual(page.published, [])
})

test('the published state carries only booleans, never page text', () => {
  const page = mountBrand({ title: 'Ship the release' })
  const state = page.published.at(-1)
  const values = [...Object.values({ ...state.views }), state.settings, state.newSession, state.sidebar, state.sessionLog, state.terminal, state.composer]
  for (const value of values) assert.equal(typeof value, 'boolean')
  // It crosses into the main process, so nothing model-written may ride along.
  assert.deepEqual(Object.keys({ ...state }).sort(), ['composer', 'newSession', 'sessionLog', 'settings', 'sidebar', 'terminal', 'views'])
})

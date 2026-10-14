/* Served on the authenticated host origin. One disposable panel per chat. */
window.DshPreviewPanel = function (host, sessionId, cwd, openURL, reportState = () => {}) {
  const key = 'dshd.preview.project:' + encodeURIComponent(sessionId)
  let saved = {}, live = true, busy = false, timer, current = {}, request = null, actionError = '', restored = false
  const managedKey = 'dshd.preview.managed:' + encodeURIComponent(sessionId)
  const urlKey = 'dshd.preview.url:' + encodeURIComponent(sessionId)
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') } catch { /* Fresh configuration. */ }
  const element = (tag, text, parent = host) => {
    const node = document.createElement(tag)
    if (text) node.textContent = text
    parent.appendChild(node)
    return node
  }
  const details = element('div')
  const summary = element('div', 'Development server · checking…', details)
  summary.className = 'dshd-pv-server-heading'
  summary.setAttribute('role', 'status')
  const form = element('form', '', details)
  form.className = 'dshd-pv-server-form'
  const field = (label, value, placeholder) => {
    const wrap = element('label', label + ' ', form)
    wrap.className = 'dshd-pv-server-field'
    const input = element('input', '', wrap)
    input.value = value || ''; input.placeholder = placeholder
    input.setAttribute('aria-label', label)
    return input
  }
  const folder = field('Project folder', saved.cwd || cwd, '/path/to/this/chat/project')
  const command = field('Launch command', saved.command, 'npm run dev -- --host 127.0.0.1')
  const controls = element('span', '', form)
  controls.className = 'dshd-pv-server-actions'
  const buttons = {}
  for (const action of ['Start', 'Stop', 'Restart', 'Open preview']) {
    const button = element('button', action, controls)
    button.type = 'button'
    button.onclick = () => action === 'Open preview' ? openURL(current.url) : change(action.toLowerCase())
    buttons[action] = button
  }
  const message = element('p', '', details)
  message.setAttribute('role', 'status')
  const logs = element('details', '', details)
  element('summary', 'Server output', logs)
  const output = element('pre', '', logs)
  const save = () => {
    try { localStorage.setItem(key, JSON.stringify({ cwd: folder.value, command: command.value })) }
    catch { message.textContent = 'Could not save this chat’s launch settings.' }
  }
  folder.onchange = save; command.onchange = save
  command.oninput = () => render(current)
  form.onsubmit = event => { event.preventDefault(); change('start') }
  function render (state) {
    current = state
    summary.textContent = 'Development server · ' + (state.status || 'checking')
    reportState({ status: state.status || 'checking', error: actionError || state.error || '' })
    const running = ['starting', 'ready', 'stopping'].includes(state.status)
    if (running && state.cwd && state.command) {
      folder.value = state.cwd; command.value = state.command; save()
    }
    buttons.Start.disabled = busy || running || !command.value.trim()
    buttons.Stop.disabled = busy || !running && state.status !== 'exited'
    buttons.Restart.disabled = busy || !command.value.trim()
    buttons['Open preview'].disabled = state.status !== 'ready' || !state.url
    folder.disabled = command.disabled = busy || running
    message.textContent = actionError || state.error || (state.status === 'stopped'
      ? 'Saved for this chat. Start manually after reopening the app.'
      : state.status === 'ready' ? 'Stop and Restart affect only this chat’s managed server.'
      : state.status === 'exited' ? 'Server exited. Check the output before restarting.'
      : state.status === 'starting' ? 'Starting server…' : state.status === 'stopping' ? 'Stopping server…' : 'Checking server…')
    output.textContent = state.output || 'No server output yet.'
    if (state.status === 'ready' && state.url) {
      try {
        const previous = localStorage.getItem(managedKey)
        const selected = localStorage.getItem(urlKey)
        localStorage.setItem(managedKey, state.url)
        if (!restored && (!selected || selected === previous || selected === state.url)) openURL(state.url)
      } catch { /* Server controls still work when browser storage is unavailable. */ }
      restored = true
    }
  }
  async function call (action) {
    request?.abort(); const controller = new AbortController(); request = controller
    const url = '/dsh-files/preview/server' + (action ? '' : '?sessionId=' + encodeURIComponent(sessionId))
    const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal,
      ...(action ? { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, sessionId, cwd: folder.value, command: command.value }) } : {}) })
    const state = await response.json()
    if (!response.ok) throw Error(state.error || 'Preview server unavailable.')
    if (live && !controller.signal.aborted) render(state)
  }
  async function change (action) {
    if (busy) return
    busy = true; actionError = ''; save(); render(current)
    try { await call(action) }
    catch (error) { if (live) { actionError = error.message; message.textContent = error.message } }
    finally { busy = false; if (live) { render(current); void refresh() } }
  }
  async function refresh () {
    if (busy || !live) return
    try { await call() }
    catch (error) { if (live && error.name !== 'AbortError') { message.textContent = error.message; reportState({ status: 'error', error: error.message }) } }
  }
  void refresh()
  timer = setInterval(refresh, 2000)
  return () => { live = false; clearInterval(timer); request?.abort(); host.replaceChildren() }
}

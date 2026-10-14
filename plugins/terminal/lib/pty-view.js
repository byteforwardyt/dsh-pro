/* Browser adapter for xterm. No terminal output is interpreted as HTML. */
window.DshPtyView = async function mountTerminal(container, cwd, openWorkspace) {
  const api = async (route, body, signal) => {
    const response = await fetch('/dsh-terminal/pty' + route, {
      credentials: 'same-origin', signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Terminal request failed.')
    return result
  }
  const abort = new AbortController()
  let live = true, session, observer, terminal, input, connecting = false, generation = 0, inputQueue = Promise.resolve()
  const header = document.createElement('div'), title = document.createElement('span')
  header.className = 'dshd-pty-head'; header.append(title)
  const status = document.createElement('div'); status.className = 'dshd-pty-status'; status.setAttribute('role', 'status')
  const screen = document.createElement('div'); screen.className = 'dshd-pty-screen'
  container.append(header, screen, status)
  const report = error => { if (live) status.textContent = error.message }
  const button = (label, action) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label
    node.addEventListener('click', () => Promise.resolve().then(action).catch(report)); header.append(node)
  }
  const fit = new window.FitAddon.FitAddon()
  const resize = () => {
    if (!live || !terminal || !screen.clientWidth || !screen.clientHeight) return
    fit.fit()
    if (session?.running) api('/resize', { id: session.id, cols: terminal.cols, rows: terminal.rows }).catch(report)
  }
  const start = async (restart = false) => {
    if (connecting) return
    connecting = true
    const current = ++generation
    status.textContent = 'Connecting…'
    try {
      if (restart && session) await api('/close', { id: session.id })
      const state = await api('/sessions', undefined, abort.signal)
      if (!live) return
      const wanted = cwd || state.roots.find(root => root.registered)?.path
      if (!wanted) {
        status.textContent = 'Choose a workspace to open a terminal.'
        button('Choose workspace', () => openWorkspace?.())
        return
      }
      let chosen = !restart && state.sessions.find(row => row.running && row.cwd === wanted)
      if (!chosen) chosen = (await api('/open', { cwd: wanted, cols: terminal.cols, rows: terminal.rows })).session
      if (!live) { if (!state.sessions.some(row => row.id === chosen.id)) await api('/close', { id: chosen.id }); return }
      session = chosen; connecting = false; title.textContent = chosen.cwd + ' · ' + chosen.shell
      terminal.reset(); resize(); terminal.focus(); status.textContent = ''
      const response = await fetch('/dsh-terminal/pty/stream?id=' + encodeURIComponent(chosen.id), { credentials: 'same-origin', signal: abort.signal })
      if (!response.ok) throw new Error('Could not attach to the terminal. Close and reopen the dock to retry.')
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      try {
        while (live && session.id === chosen.id) {
          const { value, done } = await reader.read()
          buffer += decoder.decode(value, { stream: !done })
          if (buffer.length > 4 * 1024 * 1024) throw new Error('Oversized terminal event.')
          let end
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
            if (!line || session.id !== chosen.id) continue
            const event = JSON.parse(line)
            // Wait for the emulator to consume each chunk; noisy programs must
            // not create an unbounded browser-side write queue.
            if (event.kind === 'chunk') await new Promise(resolve => {
              const finish = () => { abort.signal.removeEventListener('abort', finish); resolve() }
              abort.signal.addEventListener('abort', finish, { once: true })
              terminal.write(event.text, finish)
            })
            if (event.kind === 'session' && event.truncated) status.textContent = 'Older output was trimmed. Press Ctrl+L to redraw the current screen.'
            if (event.kind === 'error') status.textContent = event.message
            if (event.kind === 'exit') { session.running = false; status.textContent = 'Shell exited. Use Restart for a new shell.' }
          }
          if (done) break
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (live && session.id === chosen.id && session.running) status.textContent = 'Terminal connection ended. Close and reopen to reconnect.'
    } finally { if (generation === current) connecting = false }
  }
  terminal = new window.Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, monospace',
    scrollback: 5000, allowProposedApi: false, theme: { background: '#191919', foreground: '#e6e6e6' } })
  terminal.loadAddon(fit); terminal.open(screen); fit.fit()
  input = terminal.onData(data => {
    if (!session?.running) return
    const id = session.id
    // Requests stay ordered, including paste followed immediately by Enter.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(data.length, offset + 16000)
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--
      const chunk = data.slice(offset, end); offset = end
      inputQueue = inputQueue.then(() => api('/input', { id, data: chunk })).catch(report)
    }
  })
  button('Clear', () => terminal.clear())
  button('Restart', () => { start(true).catch(report) })
  observer = new ResizeObserver(resize); observer.observe(screen)
  start().catch(report)
  return () => {
    live = false; abort.abort(); observer.disconnect(); input.dispose(); terminal.dispose()
    container.replaceChildren()
  }
}

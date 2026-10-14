/**
 * Preview intents: how the agent points the Preview tab at something.
 *
 * The agent runs in the host process and the Preview pane runs in the
 * renderer, so "open this in Preview" has to cross that gap. It crosses as an
 * intent rather than a command: the host records what should be showing and
 * announces it, and the pane decides how to get there. That split is what
 * makes the feature survive the cases that matter — the tab being closed when
 * the tool runs, the pane mounting later, or two windows watching at once.
 *
 * The last intent is therefore retained, not just broadcast. A fire-and-forget
 * event is lost whenever Preview is not already open, which is precisely when
 * the agent is most likely to call the tool: it has just built something and
 * the user is still reading chat. Retaining it means opening the tab afterwards
 * lands on the right page instead of an empty scan.
 *
 * Nothing here decides what is safe to open. The route layer owns the scheme
 * check and the workspace containment fence, for the same reason the file
 * routes own theirs: this module cannot see the request that produced a value.
 */

/** Enough to notice a dropped connection, short enough to keep a proxy awake. */
const HEARTBEAT_MS = 25_000

export function createPreviewIntents () {
  /** res -> its heartbeat timer. */
  const streams = new Map()
  const latest = new Map()
  let sequence = 0
  let closed = false

  function drop (res) {
    const beat = streams.get(res)?.beat
    if (beat) clearInterval(beat)
    streams.delete(res)
  }

  /**
   * Attach one SSE reader. The retained intent is replayed immediately so a
   * pane that mounts after the tool ran still learns where it should be.
   */
  function subscribe (req, res) {
    if (closed) { res.writeHead(503).end(); return }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    // Without an immediate byte some proxies hold the response open unflushed,
    // and EventSource never reports itself connected.
    res.write(': open\n\n')
    const beat = setInterval(() => { if (!res.write(': beat\n\n')) { drop(res); res.end() } }, HEARTBEAT_MS)
    const sessionId = new URL(req.url || '/', 'http://localhost').searchParams.get('sessionId') || ''
    streams.set(res, { beat, sessionId })
    if (latest.has(sessionId)) send(res, latest.get(sessionId))
    const finish = () => { drop(res); res.end() }
    req.on('close', finish)
    req.on('error', finish)
  }

  function send (res, intent) {
    // A write to an ended response returns false rather than throwing, so a
    // reader that vanished between the beat and here is dropped, not fatal.
    if (!res.write(`event: preview\ndata: ${JSON.stringify(intent)}\n\n`)) { drop(res); res.end() }
  }

  /**
   * Record and announce a target.
   *
   * @returns the stored intent, including how many panes were listening. The
   *   tool reports that number back to the agent rather than claiming success:
   *   zero readers means the user has not opened Preview yet, which is a
   *   different outcome from a page that loaded, and saying so keeps the agent
   *   from telling the user to look at something that is not on screen.
   */
  function publish (target) {
    if (closed) return null
    sequence += 1
    const sessionId = target.sessionId || ''
    const intent = { ...target, sessionId, id: sequence, at: Date.now() }
    latest.set(sessionId, intent)
    let readers = 0
    for (const [res, stream] of [...streams]) {
      if (stream.sessionId !== sessionId) continue
      readers += 1
      send(res, intent)
    }
    return { ...intent, readers }
  }

  function dispose () {
    closed = true
    for (const res of [...streams.keys()]) { drop(res); res.end() }
    latest.clear()
  }

  // Do not replay a stopped managed server, or erase a newer manual target.
  function clearManaged (sessionId, url) {
    const intent = latest.get(sessionId)
    if (intent?.managed && intent.url === url) latest.delete(sessionId)
  }
  return { subscribe, publish, clearManaged, dispose, get readers () { return streams.size } }
}

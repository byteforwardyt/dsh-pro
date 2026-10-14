'use strict'
/**
 * Phone access — a PAIRED reverse proxy in front of the loopback host.
 *
 * The harness API is deliberately unauthenticated and its request-trust fence
 * rejects any non-loopback Host — both are correct for a single-user desktop
 * app, and both make "just open the port" impossible: raw exposure would hand
 * an agent with shell access to everything on the Wi-Fi, and the fence would
 * refuse the traffic anyway.
 *
* So this proxy is the sanctioned path, and pairing is the boundary:
*
 *   - It listens on the LAN address, refuses callers on this Mac at the
 *     socket, and gives an unpaired client ONLY the pairing page: a six-digit
 *     code the user reads off the Settings screen. Ten wrong guesses lock that
 *     client out, doubling to a quarter hour. The code is single-use, and
 *     thirty wrong guesses from anywhere void it outright.
  *   - Pairing sets an HttpOnly cookie carrying a 128-bit token minted for
  *     this enablement. Every later request must carry it.
 *   - Every request must address this listener by its own address and port,
 *     so a rebound DNS name is refused before anything else runs, and a
 *     supplied Origin must be exactly this proxy's own.
  *   - Authenticated traffic is tunneled to 127.0.0.1 with the Host, Origin
 *     and Referer headers rewritten to the loopback origin, which is what
 *     lets the harness's own trust fence keep doing its job unchanged.
 *   - Nothing persists. Disable — or quit the app — and the token, the code
 *     and the listener are gone.
 *
 * What pairing is NOT, stated plainly here because the pairing page does not
 * say it: a paired phone reaches the whole harness API, /dsh-terminal/run
 * included, so pairing hands out a shell on this Mac. One token is shared by
 * every device that pairs, and the only revocation is turning access off.
 *
 * Plain HTTP on purpose: a self-signed certificate would train users to click
 * through TLS warnings, worse than honestly saying "trusted Wi-Fi only". The
 * price, also worth saying out loud: the code and the cookie both cross the
 * Wi-Fi in cleartext, so anyone who can watch the network can replay them.
 */

const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const crypto = require('node:crypto')
const qrcode = require('./vendor/qrcode.cjs')

/** The first routable IPv4 address, preferring ordinary interface names. */
function lanAddress () {
  const interfaces = os.networkInterfaces()
  const names = Object.keys(interfaces).sort((a, b) => {
    const rank = (n) => (/^(en|eth|wlan)/.test(n) ? 0 : 1)
    return rank(a) - rank(b) || a.localeCompare(b)
  })
  for (const name of names) {
    for (const net_ of interfaces[name] ?? []) {
      // Skip loopback (internal) AND link-local APIPA (169.254.x.x): a phone on
      // the real Wi-Fi can reach neither, so advertising one gives a URL and QR
      // that silently never connect.
      if (net_.family === 'IPv4' && !net_.internal && !net_.address.startsWith('169.254.')) {
        return net_.address
      }
    }
  }
  return null
}

const COOKIE = 'dshd_phone'

/**
 * The harness's API capability cookie. Requests arriving over the LAN carry no
 * such cookie - only the Electron session is seeded with it - so the proxy has
 * to restate it upstream or every paired request would be refused. The name is
 * duplicated from CAPABILITY_COOKIE in plugins/host-files-api/lib/trust.js
 * because that module is ESM in the harness process and this file is CJS in
 * the Electron main process; scripts/test/capability-cookie.test.cjs asserts
 * the copies agree.
 */
const HOST_CAPABILITY_COOKIE = 'dsh_cap'

function parseCookies (header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

/**
 * Constant-time equality that never throws on hostile input.
 *
 * `candidate` comes straight off an attacker-controlled Cookie header. Comparing
 * by string .length was unsafe: a 32-CHARACTER value of multibyte UTF-8 passes a
 * char-length check yet yields a Buffer longer than 32 bytes, and
 * crypto.timingSafeEqual THROWS "Input buffers must have the same byte length"
 * on a length mismatch — an unhandled throw in the request handler that an
 * unpaired LAN client could use to crash the app. So compare byte lengths first
 * and only call timingSafeEqual on equal-length buffers. The length check leaks
 * nothing secret: the token length is fixed and public.
 */
function tokenMatches (candidate, token) {
  if (typeof candidate !== 'string') return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** Wrong guesses one client gets before that client is locked out. */
const TRIES_PER_CLIENT = 10
/** Its first lockout. Each further lockout for that client doubles, to a cap. */
const LOCKOUT_MS = 60_000
const LOCKOUT_CEILING_MS = 15 * 60_000
/** Wrong guesses, summed across every client, that void the current code. */
const ROTATE_AFTER_WRONG = 30
/** Client entries kept. See clientState for why the bound fails closed. */
const MAX_CLIENTS = 256
/**
 * How long a code stays usable after it has been spent.
 *
 * Without it, a browser that fires the pairing form twice - a double tap, a
 * retried POST - charges the second submission as a wrong guess against a code
 * that pairing itself rotated away a millisecond earlier. Measured: twenty
 * simultaneous correct submissions issued one cookie and cost nine counted
 * failures. Ten seconds is long enough for a retry and short enough that a
 * code read over a shoulder is still spent by the time anyone can type it.
 */
const SPENT_CODE_GRACE_MS = 10_000

/** A fresh six-digit pairing code. */
function mintCode () {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

/**
 * Is this exactly the authority the listener answers to?
 *
 * The proxy used to overwrite Host unconditionally before forwarding, which
 * gave away the harness's load-bearing rebind check — trust.js calls Host "the
 * load-bearing check… a rebound DNS name reaches us with its own hostname in
 * Host". Measured: a paired request claiming a Host of evil.attacker.example
 * was proxied happily and the harness saw 127.0.0.1:57254. That made a page on
 * any domain rebinding to this Mac's LAN address same-origin with the pairing
 * form, free to script guesses at it and read the answers.
 *
 * The first attempt at this accepted any IP literal on our port, on the theory
 * that rebinding needs a NAME. A re-audit showed why that is the wrong shape:
 * the same rule applied to Origin accepted http://10.9.9.9:OURPORT and then
 * rewrote it to loopback upstream, which is the laundering the fix was for. So
 * the rule is an exact match against this listener's own address and port. The
 * listener binds one address, so nothing is lost by refusing the others.
 *
 * The net.isIP guard is not decoration. If the address were ever a name, every
 * caller here would start comparing against something a DNS rebind could
 * satisfy, and this fence would fail silently open.
 */
function ownAuthority (value, address, port) {
  if (typeof value !== 'string' || !(port > 0) || typeof address !== 'string') return false
  const family = net.isIP(address)
  if (family === 0) return false
  return value.trim() === (family === 6 ? `[${address}]:${port}` : `${address}:${port}`)
}

/**
 * Is this peer a process on this Mac rather than another device?
 *
 * Binding the LAN address does NOT keep local callers out, which is what the
 * first version of this file claimed. The kernel routes a connection to this
 * Mac's own address internally without it ever touching the wire, and it
 * arrives with our own address as the peer. Measured from an ordinary local
 * process with no capability cookie: connecting to 192.168.1.147:PORT
 * succeeded, POST /dshd-pair with the code returned 303, and the paired
 * request reached the harness. Even binding 127.0.0.1 as the client's source
 * address does not change the peer the server sees.
 *
 * A phone always arrives from a different address, so refusing our own and the
 * loopback range is precise. An unreadable peer is refused too: this decides
 * whether a caller may attack a six-digit secret, so it fails closed.
 */
function localPeer (remote, address) {
  if (typeof remote !== 'string' || remote === '') return true
  const bare = remote.replace(/^::ffff:/i, '')
  return bare === address || bare === '::1' || bare.startsWith('127.')
}

/**
 * Find or create this client's counters, or null when there is no room.
 *
 * The table has to be bounded because the key is attacker-chosen: one entry
 * per source address, and someone with a subnet of them would grow it without
 * limit. The first version evicted the oldest entry outright, which made the
 * bound fail OPEN - an evicted address came back to a fresh set of counters,
 * so cycling more than MAX_CLIENTS addresses deleted the doubling backoff and
 * with it the rate limit the whole gate rests on. Only a finished entry may be
 * evicted, and when every slot is a live lockout there is no room: that is not
 * a state honest traffic reaches, so pairing is refused rather than widened.
 *
 * Pure and exported because the interesting case needs more source addresses
 * than one machine has.
 */
function admitClient (clients, key, now, max = MAX_CLIENTS) {
  const existing = clients.get(key)
  if (existing) return existing
  if (clients.size >= max) {
    let room = false
    for (const [other, state] of clients) {
      if (state.until <= now) { clients.delete(other); room = true; break }
    }
    if (!room) return null
  }
  const entry = { bad: 0, lockouts: 0, until: 0 }
  clients.set(key, entry)
  return entry
}

function pairingPage (state) {
  const problem = state === 'locked'
    ? 'Too many tries. Wait, then read the current code off your Mac.'
    : state === 'wrong'
      ? 'That code is not the current one. Check Settings on your Mac.'
      : ''
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pair with DSH PRO</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0a0a0a; color: #f9fafb; }
  form { display: grid; gap: 14px; justify-items: center; padding: 32px; text-align: center; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; }
  p { margin: 0; font-size: 14px; color: #adb2b8; max-width: 34ch; }
  input { font-size: 28px; letter-spacing: .35em; text-align: center; width: 7.5ch;
    padding: 10px 0 10px .35em; border-radius: 12px; border: 1px solid rgba(255,255,255,.18);
    background: rgba(255,255,255,.06); color: inherit; }
  button { font-size: 15px; font-weight: 600; padding: 10px 22px; border-radius: 999px;
    border: none; background: #fff; color: #0a0a0a; cursor: pointer; }
  .err { color: #f85149; font-size: 13px; min-height: 18px; }
</style>
<form method="POST" action="/dshd-pair">
  <h1>Pair with DSH PRO</h1>
  <p>Enter the six-digit code from Settings → Phone access on your Mac.</p>
  <input name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autofocus autocomplete="one-time-code">
  <div class="err">${problem}</div>
  <button type="submit">Pair</button>
</form>`
}

/**
 * A crisp, scalable SVG QR of `text` (ECC level M, quiet zone 4). Rendered in
 * the phone-access tab so a camera can open the pairing page without typing
 * the address. Verified to decode back to the exact URL.
 */
function qrSvg (text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const quiet = 4
  const size = n + quiet * 2
  let rects = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) rects += '<rect x="' + (c + quiet) + '" y="' + (r + quiet) + '" width="1" height="1"/>'
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size +
    '" shape-rendering="crispEdges"><rect width="' + size + '" height="' + size +
    '" fill="#fff"/><g fill="#000">' + rects + '</g></svg>'
}

/**
 * Start the paired proxy in front of `hostUrl`.
 * @param {string} hostUrl - the harness origin, e.g. http://127.0.0.1:41712
 * @param {string | null} [capability] - this run's API capability, restated on
 *   every upstream request. Omitted only when the host was started without one.
 * @param {{allowLocalPeers?: boolean}} [options] - allowLocalPeers is a test
 *   seam and nothing else. The proxy refuses callers on this Mac, and the test
 *   suite runs on this Mac, so it is indistinguishable from the caller being
 *   refused. It is a parameter rather than an environment variable so that
 *   flipping it needs code execution in the Electron main process, by which
 *   point the six digits are the least of anyone's problems. Production calls
 *   this with two arguments. spentCodeGraceMs is the same kind of seam: the
 *   default is ten seconds, and a test that wants to watch a spent code die
 *   should not sit there for ten seconds to do it.
 * @returns {Promise<{url: string, code: string, stop: () => void} | {error: string}>}
 */
async function startPhoneAccess (hostUrl, capability = null, { allowLocalPeers = false, spentCodeGraceMs = SPENT_CODE_GRACE_MS, upstreamAuthCookie = '' } = {}) {
  if (upstreamAuthCookie && !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(upstreamAuthCookie)) {
    throw new Error('Invalid host authentication cookie')
  }
  const address = lanAddress()
  if (!address) return { error: 'No Wi-Fi or Ethernet address found on this Mac.' }
  let hostPort
  try { hostPort = Number(new URL(hostUrl).port) } catch { return { error: 'The app host is not running yet.' } }
  if (!Number.isInteger(hostPort) || hostPort <= 0) return { error: 'The app host is not running yet.' }

  const token = crypto.randomBytes(16).toString('hex')
  let code = mintCode()
  /** The code pairing just spent, honoured briefly. See SPENT_CODE_GRACE_MS. */
  let spentCode = null
  let spentUntil = 0
  let wrongTotal = 0
  /** remoteAddress -> { bad, lockouts, until }. Per client, because a single
   *  pair of counters let a stranger on the Wi-Fi lock the owner's own phone
   *  out of pairing indefinitely: ten guesses a minute from anywhere, and the
   *  correct code answered 429 for as long as they kept it up. */
  const clients = new Map()
  /** Sockets this proxy upgraded, so stop() can actually close them. */
  const tunnels = new Set()
  /** This listener's own port, filled the moment listen() succeeds. */
  let publicPort = 0

  const loopbackOrigin = `127.0.0.1:${hostPort}`

  /**
   * Void the current code and start the shared budget again.
   *
   * Rotation is what stops guesses from accumulating. A fixed ten-per-minute
   * allowance against a static six-digit secret is 14,400 guesses a day into a
   * space of a million: about 1.4% a day, even odds inside five weeks, for a
   * feature people leave switched on. Settings re-reads the code while the
   * panel is open, so the desktop always shows the one that will work.
   *
   * The cost, stated rather than hidden: the budget is global while the lockout
   * is per client, so an attacker with many addresses forces rotations faster
   * than an owner can walk to their phone. Measured from one address the steady
   * state is a rotation every 45 minutes; roughly 45 addresses puts it under a
   * minute. That is degradation, not the indefinite lockout this replaced, and
   * it is the price of the property that matters more: without rotation, that
   * same multi-address attacker converges on a static code in about 12 days.
   */
  const rotate = (spend) => {
    if (spend) { spentCode = code; spentUntil = Date.now() + spentCodeGraceMs }
    code = mintCode()
    wrongTotal = 0
  }
  /** A code that pairs: the current one, or one spent moments ago. */
  const codeAccepted = (supplied) => tokenMatches(supplied, code) ||
    (spentCode !== null && Date.now() < spentUntil && tokenMatches(supplied, spentCode))

  const clientKey = (req) => req.socket?.remoteAddress ?? 'unknown'
  const clientState = (req) => admitClient(clients, clientKey(req), Date.now())
  /** Read-only, so an unpaired GET does not mint a table entry. */
  const lockedFor = (req) => (clients.get(clientKey(req))?.until ?? 0) > Date.now()

  const authed = (req) => tokenMatches(parseCookies(req.headers.cookie)[COOKIE], token)

  /** Does this request address the listener by its own address and port? */
  const addressedToUs = (req) => ownAuthority(req.headers.host, address, publicPort)

  /**
   * A supplied Origin has to be this proxy's own.
   *
   * Rewriting a foreign one to loopback, which is what this file used to do,
   * laundered it through the harness's Origin check and left that fence
   * standing on Sec-Fetch-Site alone — the very thing trust.js says is "not
   * defence in depth". Absence stays legal: a top-level navigation and a media
   * element both send no Origin at all.
   *
   * The scheme is compared too. An earlier pass checked only the authority, so
   * https://our.address:ourport was accepted and then rewritten to loopback,
   * and so was any other IP on our port: measured, http://10.9.9.9:OURPORT
   * reached the harness as http://127.0.0.1:HOSTPORT.
   */
  const originAllowed = (req) => {
    const origin = req.headers.origin
    if (origin === undefined) return true
    let parsed = null
    try { parsed = new URL(origin) } catch { return false }
    return parsed.protocol === 'http:' && ownAuthority(parsed.host, address, publicPort)
  }

  /** Headers forwarded upstream, with the identity ones rewritten to loopback
   *  so the harness's Host/Origin trust fences see exactly what they expect.
   *  Both have already been checked against this listener's own authority, so
   *  this is a translation of headers we vouched for, not a laundering of
   *  whatever the caller sent. */
  const upstreamHeaders = (req) => {
    const headers = { ...req.headers }
    headers.host = loopbackOrigin
    if (headers.origin !== undefined) headers.origin = `http://${loopbackOrigin}`
    // Referer is no part of the harness fence and can name any site the phone
    // navigated in from, so a foreign one is dropped rather than rewritten.
    if (headers.referer !== undefined) {
      let referer = null
      try { referer = new URL(headers.referer) } catch {}
      if (referer?.protocol === 'http:' && ownAuthority(referer.host, address, publicPort)) headers.referer = `http://${loopbackOrigin}/`
      else delete headers.referer
    }
    delete headers.cookie // the pairing cookie is the proxy's, never the host's
    // Restate the capability instead. The pairing check above has already run,
    // so only a paired client reaches this point.
    if (capability) headers.cookie = `${HOST_CAPABILITY_COOKIE}=${capability}`
    if (upstreamAuthCookie) headers.cookie = [headers.cookie, upstreamAuthCookie].filter(Boolean).join('; ')
    return headers
  }

  const server = http.createServer((req, res) => {
    if (!addressedToUs(req)) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Phone access answers only to its own address.')
    }
    if (!originAllowed(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Cross-origin request refused.')
    }

    if (req.url === '/dshd-pair' && req.method === 'POST') {
      // A browser that resubmitted the form is already paired. Answer it
      // rather than spend a guess on a code that pairing has since rotated.
      if (authed(req)) { res.writeHead(303, { location: '/' }); return res.end() }
      let body = ''
      req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy() })
      req.on('end', () => {
        const now = Date.now()
        const client = clientState(req)
        // A null client means every tracked address is mid-lockout, which is
        // not a state honest traffic produces. Refuse rather than make room.
        if (client === null || now < client.until) {
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' })
          return res.end(pairingPage('locked'))
        }
        const supplied = new URLSearchParams(body).get('code') ?? ''
        // Constant-time, and never-throwing, like the token check — consistency
        // in the same auth path (the lockout already bounds guessing).
        if (codeAccepted(supplied)) {
          client.bad = 0
          client.lockouts = 0
          // Single use. A code read over someone's shoulder, or left on screen,
          // is spent the moment it pairs one device.
          if (tokenMatches(supplied, code)) rotate(true)
          res.writeHead(303, {
            'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
            location: '/',
          })
          return res.end()
        }
        client.bad += 1
        wrongTotal += 1
        if (wrongTotal >= ROTATE_AFTER_WRONG) rotate()
        if (client.bad >= TRIES_PER_CLIENT) {
          client.bad = 0
          client.lockouts += 1
          // Doubling, to a ceiling. A flat minute is a standing allowance of
          // ten guesses a minute for as long as an attacker cares to keep at
          // it; doubling turns a sustained campaign into ten guesses a quarter
          // hour, and costs an owner who fat-fingers the code once nothing.
          client.until = now + Math.min(LOCKOUT_MS * 2 ** (client.lockouts - 1), LOCKOUT_CEILING_MS)
        }
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
        res.end(pairingPage(Date.now() < client.until ? 'locked' : 'wrong'))
      })
      return
    }

    if (!authed(req)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(pairingPage(lockedFor(req) ? 'locked' : ''))
    }

    const upstream = http.request({
      host: '127.0.0.1',
      port: hostPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req),
    }, (answer) => {
      const headers = { ...answer.headers }
      delete headers['set-cookie'] // host credentials remain in the desktop process
      res.writeHead(answer.statusCode ?? 502, headers)
      answer.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('DSH PRO is not reachable')
    })
    // If the phone client goes away, abort the upstream request. Otherwise a
    // streaming response (SSE, or a long harness turn) keeps the loopback
    // connection open and the harness working with nobody listening.
    res.on('close', () => { upstream.destroy() })
    req.pipe(upstream)
  })

  // WebSockets: same cookie gate, then a raw TCP tunnel with the handshake's
  // identity headers rewritten the same way the HTTP path rewrites them.
  server.on('upgrade', (req, socket, head) => {
    if (!addressedToUs(req) || !originAllowed(req) || !authed(req)) { socket.destroy(); return }
    const upstream = net.connect({ host: '127.0.0.1', port: hostPort }, () => {
      const headers = upstreamHeaders(req)
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    // Node stops tracking a socket once it is upgraded, so server.close() and
    // closeAllConnections() both walk straight past it. Measured: a tunnel
    // opened before stop() was still open afterwards and still passing bytes
    // in both directions. Remember them so stop() can mean what it says.
    tunnels.add(socket)
    tunnels.add(upstream)
    // Each leg forgets only ITSELF. Wiring one handler to both closed half of
    // every tunnel behind stop(): whichever leg died first evicted its still
    // live partner from the set, and stop() then walked past it. Measured in
    // both directions, with the surviving half still connected and writable.
    socket.on('close', () => tunnels.delete(socket))
    upstream.on('close', () => tunnels.delete(upstream))
    const drop = () => { socket.destroy(); upstream.destroy() }
    upstream.on('error', drop)
    socket.on('error', drop)
  })

  // Callers on this Mac are refused at the socket, before a byte is read.
  // Binding the LAN address rather than 0.0.0.0 removes the 127.0.0.1 listener
  // but NOT local reachability: the kernel routes a local connection to this
  // Mac's own address internally. See localPeer.
  if (!allowLocalPeers) {
    server.on('connection', (socket) => {
      if (localPeer(socket.remoteAddress, address)) socket.destroy()
    })
  }

  const listenOn = (port) => new Promise((resolve, reject) => {
    const failed = (error) => reject(error)
    server.once('error', failed)
    // The host's own stable port plus one keeps the phone URL familiar across
    // launches when it is free; any bind failure falls back to OS-assigned.
    server.listen({ host: address, port, exclusive: true }, () => {
      server.off('error', failed)
      publicPort = server.address().port
      resolve(publicPort)
    })
  })
  let port
  try {
    port = await listenOn(hostPort + 1)
  } catch {
    try { port = await listenOn(0) } catch { return { error: 'Could not open a port on this network.' } }
  }

  // Once listen() succeeds the bind-failure listener is removed, which left the
  // server with no 'error' listener at all: a later server-level error would
  // have been an uncaught exception in the Electron main process, taking the
  // whole app down. Nothing observed triggering one, so this is robustness
  // rather than a fixed bug - but the cost of being wrong is the app.
  server.on('error', () => {})

  const url = `http://${address}:${port}`
  return {
    url,
    // A getter, not a snapshot: the code rotates, and Settings has to show the
    // one that will actually pair.
    get code () { return code },
    qrSvg: qrSvg(url),
    stop: () => {
      try { server.close(); server.closeAllConnections?.() } catch {}
      for (const socket of tunnels) { try { socket.destroy() } catch {} }
      tunnels.clear()
    },
  }
}

// Exported for direct testing of the security-sensitive edges: the
// constant-time comparison must never throw on hostile input, address
// selection must skip unreachable ranges, the Host fence must refuse every
// name a rebind could arrive under, and localPeer decides whether a caller is
// allowed to attack six digits at all.
module.exports = { startPhoneAccess, lanAddress, tokenMatches, ownAuthority, localPeer, admitClient }

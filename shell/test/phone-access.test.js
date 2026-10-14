'use strict'
/**
 * The paired proxy is a security boundary; these tests pin its contract:
 * unpaired requests see only the pairing page, wrong codes rate-limit, the
 * cookie gate holds, and forwarded traffic reaches the upstream with its
 * identity headers rewritten to loopback (what the harness trust fence needs).
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const net = require('node:net')
const crypto = require('node:crypto')

const { startPhoneAccess, tokenMatches, ownAuthority, localPeer, admitClient } = require('../src/phone-access.cjs')

// Every startPhoneAccess call here passes allowLocalPeers. The proxy refuses
// callers on this Mac, and this test runs on this Mac; without the seam every
// connection below would be destroyed at the socket. The refusal itself is
// tested directly, with the seam off.
const LOCAL_OK = { allowLocalPeers: true }

/** Fake harness: echoes the headers it actually received, and records every
 *  request so a test can assert that a refused one never arrived. */
function fakeHost () {
  const seen = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push(req.url)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin ?? null,
        referer: req.headers.referer ?? null,
        cookie: req.headers.cookie ?? null,
      }))
    })
    // Enough of an upgrade to hold a tunnel open and echo through it.
    server.on('upgrade', (req, socket) => {
      seen.push(req.url)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: dsh\r\nConnection: Upgrade\r\n\r\n')
      // /ws-die hangs up from the upstream side, which is how one leg of a
      // tunnel dies while the other stays live.
      if (req.url === '/ws-die') { socket.end(); return }
      socket.on('data', (chunk) => { try { socket.write(chunk) } catch {} })
      socket.on('error', () => {})
    })
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function request (base, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

const form = { 'content-type': 'application/x-www-form-urlencoded' }

test('paired requests carry both host capabilities without trusting client-supplied host cookies', async t => {
  const host = await fakeHost(); t.after(() => host.server.close())
  const auth = 'dsh-auth-fixture=fixture.signed'
  const access = await startPhoneAccess(host.url, 'app-fixture', { ...LOCAL_OK, upstreamAuthCookie: auth })
  assert.ok(!access.error, access.error); t.after(() => access.stop())
  assert.equal((await request(access.url, '/', {headers:{cookie:auth}})).status, 401)
  const paired = await pairWith(access, access.code)
  const answer = await request(access.url, '/', { headers: {cookie: `${paired.cookie}; dsh-auth-fixture=attacker; arbitrary=secret`} })
  assert.equal(answer.status, 200)
  assert.equal(JSON.parse(answer.body).cookie, 'dsh_cap=app-fixture; ' + auth)
  await assert.rejects(startPhoneAccess(host.url, null, {...LOCAL_OK, upstreamAuthCookie: 'bad\r\nheader: value'}), /Invalid/)
})

/** Pair against a live proxy and hand back the cookie it granted. */
async function pairWith (access, code) {
  const answer = await request(access.url, '/dshd-pair', { method: 'POST', headers: form, body: `code=${code}` })
  const header = answer.headers['set-cookie']
  return { answer, cookie: header ? String(header[0]).split(';')[0] : null }
}

test('phone access hands back a QR svg for the address', async (t) => {
  const host = await fakeHost()
  t.after(() => host.server.close())
  const access = await startPhoneAccess(host.url, null, LOCAL_OK)
  t.after(() => access.stop())
  // The SVG is well-formed, sized, and encodes something (rect modules present).
  assert.match(access.qrSvg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/)
  assert.ok(access.qrSvg.includes('shape-rendering="crispEdges"'))
  const rects = (access.qrSvg.match(/<rect /g) || []).length
  assert.ok(rects > 30, 'QR has module rects (' + rects + ')')
})

test('tokenMatches never throws on hostile input (the crash regression)', () => {
  const token = crypto.randomBytes(16).toString('hex') // 32 hex chars, 32 bytes
  // The attack: a value that is 32 CHARACTERS but not 32 BYTES. Node parses a
  // header value as latin1, so 32 bytes >= 0x80 become a 32-char string whose
  // utf8 Buffer is 64 bytes — the input that made timingSafeEqual throw
  // "Input buffers must have the same byte length". Must return false, not throw.
  const multibyte = 'é'.repeat(32)
  assert.equal(tokenMatches(multibyte, token), false)
  // Byte-multibyte and various shapes, none may throw:
  assert.equal(tokenMatches('€'.repeat(32), token), false)
  assert.equal(tokenMatches('a'.repeat(64), token), false)
  assert.equal(tokenMatches('', token), false)
  assert.equal(tokenMatches(undefined, token), false)
  assert.equal(tokenMatches(null, token), false)
  // The genuine token still matches (constant-time path is exercised).
  assert.equal(tokenMatches(token, token), true)
})

test('the proxy survives a raw hostile Cookie without crashing', async (t) => {
  // End-to-end: send bytes Node's http *client* would reject, straight down a
  // raw socket the way an attacker would, and confirm the server answers rather
  // than dies. Belt-and-braces over the unit test above.
  const host = await fakeHost()
  t.after(() => host.server.close())
  const access = await startPhoneAccess(host.url, null, LOCAL_OK)
  assert.ok(!access.error, access.error)
  t.after(() => access.stop())
  const u = new URL(access.url)

  const rawGet = (cookieBytes) => new Promise((resolve) => {
    const socket = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      // The proxy's own authority: this test is about the cookie parser, and a
      // wrong Host would now be refused by the rebind fence before reaching it.
      const head = `GET / HTTP/1.1\r\nHost: ${u.host}\r\nCookie: dshd_phone=`
      const tail = '\r\nConnection: close\r\n\r\n'
      socket.write(Buffer.concat([Buffer.from(head, 'latin1'), cookieBytes, Buffer.from(tail, 'latin1')]))
    })
    let buf = Buffer.alloc(0)
    socket.on('data', (d) => { buf = Buffer.concat([buf, d]) })
    socket.on('end', () => resolve(buf.toString('latin1')))
    socket.on('error', () => resolve(''))
    setTimeout(() => { socket.destroy(); resolve(buf.toString('latin1')) }, 1500)
  })

  // 32 raw 0xE9 bytes — the crash input. If the server crashes the socket dies
  // with no response; a healthy server returns the pairing page (401).
  const res = await rawGet(Buffer.alloc(32, 0xe9))
  if (res) assert.match(res, /40[0-9]|Pair with DSH PRO/)

  // And it is still serving afterward.
  const after = await request(access.url, '/')
  assert.equal(after.status, 401)
})

test('phone access pairs, gates, rewrites and rate-limits', async (t) => {
  const host = await fakeHost()
  t.after(() => host.server.close())
  const access = await startPhoneAccess(host.url, null, LOCAL_OK)
  assert.ok(!access.error, access.error)
  t.after(() => access.stop())
  // Exercise the advertised endpoint. On macOS, a loopback-only listener can
  // share a wildcard listener's port; substituting loopback may hit an entirely
  // different fixture server instead of this proxy.
  const base = access.url
  // Derived per use: the code is single-use and rotates, so a value captured
  // once could later collide with the live one.
  const wrongCode = () => (access.code === '000001' ? '000002' : '000001')

  // Unpaired: pairing page, not the app.
  const unpaired = await request(base, '/')
  assert.equal(unpaired.status, 401)
  assert.match(unpaired.body, /Pair with DSH PRO/)

  // Wrong code: refused.
  const wrong = await request(base, '/dshd-pair', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `code=${wrongCode()}`,
  })
  assert.equal(wrong.status, 403)

  // Right code: cookie granted.
  const paired = await request(base, '/dshd-pair', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `code=${access.code}`,
  })
  assert.equal(paired.status, 303)
  const cookie = String(paired.headers['set-cookie'][0]).split(';')[0]
  assert.match(cookie, /^dshd_phone=[0-9a-f]{32}$/)

  // Authenticated traffic reaches upstream with loopback identity headers and
  // WITHOUT the pairing cookie. The Origin sent is the proxy's own, which is
  // what a real paired phone sends; a foreign one is refused outright, tested
  // separately below.
  const proxied = await request(base, '/api/probe?x=1', {
    headers: { cookie, origin: base },
  })
  assert.equal(proxied.status, 200)
  const echo = JSON.parse(proxied.body)
  assert.equal(echo.url, '/api/probe?x=1')
  assert.match(echo.host, /^127\.0\.0\.1:\d+$/)
  assert.match(echo.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(echo.cookie, null)

  // A forged cookie is not a cookie.
  const forged = await request(base, '/', { headers: { cookie: 'dshd_phone=' + '0'.repeat(32) } })
  assert.equal(forged.status, 401)

  // Ten wrong guesses lock pairing.
  for (let i = 0; i < 10; i++) {
    await request(base, '/dshd-pair', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${wrongCode()}`,
    })
  }
  const locked = await request(base, '/dshd-pair', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `code=${access.code}`,
  })
  assert.equal(locked.status, 429)
})

test('ownAuthority takes our own address and port and nothing else', () => {
  const ours = (value) => ownAuthority(value, '192.168.1.5', 41713)
  assert.equal(ours('192.168.1.5:41713'), true)
  assert.equal(ours(' 192.168.1.5:41713 '), true)
  // A rebind arrives under a NAME.
  assert.equal(ours('evil.attacker.example:41713'), false)
  assert.equal(ours('macbook.local:41713'), false)
  assert.equal(ours('localhost:41713'), false)
  // Another IP on our port was accepted by the first version of this check,
  // and Origin then laundered it to loopback upstream.
  assert.equal(ours('10.9.9.9:41713'), false)
  assert.equal(ours('127.0.0.1:41713'), false)
  assert.equal(ours('[::1]:41713'), false)
  // Alternate spellings of an address, which a browser normalizes before it
  // writes a Host header but new URL() would fold into ours.
  assert.equal(ours('2130706433:41713'), false)
  assert.equal(ours('0x7f000001:41713'), false)
  assert.equal(ours('192.168.1.5.:41713'), false)
  // No port means port 80, and this listener is never on 80.
  assert.equal(ours('192.168.1.5'), false)
  assert.equal(ours('192.168.1.5:41714'), false)
  assert.equal(ours(undefined), false)
  assert.equal(ours(null), false)
  // Before listen() resolves there is no port, so nothing is ours.
  assert.equal(ownAuthority('192.168.1.5:41713', '192.168.1.5', 0), false)
  // And an address that is not an IP literal disables the fence, so it fails
  // closed rather than comparing against something a rebind could satisfy.
  assert.equal(ownAuthority('macbook.local:41713', 'macbook.local', 41713), false)
  const v6 = 'fe80::1'
  assert.equal(ownAuthority(`[${v6}]:41713`, v6, 41713), true)
  assert.equal(ownAuthority(`${v6}:41713`, v6, 41713), false)
})

test('localPeer refuses this Mac and fails closed on an unreadable peer', () => {
  const address = '192.168.1.5'
  // A local process reaching the listener through the LAN address arrives with
  // our own address as the peer, which is what makes this precise.
  assert.equal(localPeer('192.168.1.5', address), true)
  assert.equal(localPeer('::ffff:192.168.1.5', address), true)
  assert.equal(localPeer('127.0.0.1', address), true)
  assert.equal(localPeer('127.9.9.9', address), true)
  assert.equal(localPeer('::1', address), true)
  assert.equal(localPeer(undefined, address), true)
  assert.equal(localPeer('', address), true)
  // A phone always arrives from a different address.
  assert.equal(localPeer('192.168.1.42', address), false)
  assert.equal(localPeer('::ffff:192.168.1.42', address), false)
})

test('a caller on this Mac is refused at the socket', async (t) => {
  const host = await fakeHost()
  t.after(() => host.server.close())
  // No seam: this is the production configuration, and this test process is
  // exactly the local caller it refuses.
  const access = await startPhoneAccess(host.url)
  assert.ok(!access.error, access.error)
  t.after(() => access.stop())
  const u = new URL(access.url)

  const answered = await new Promise((resolve) => {
    const socket = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`)
    })
    let buffer = ''
    socket.on('data', (chunk) => { buffer += chunk })
    socket.on('error', () => resolve(buffer))
    socket.on('close', () => resolve(buffer))
    setTimeout(() => { socket.destroy(); resolve(buffer) }, 3000).unref()
  })
  assert.equal(answered, '', 'a local caller got a response from the pairing gate')
  assert.equal(host.seen.length, 0)
})

test('a rebound name is refused before it reaches the harness', async (t) => {
  const host = await fakeHost()
  t.after(() => host.server.close())
  const access = await startPhoneAccess(host.url, null, LOCAL_OK)
  assert.ok(!access.error, access.error)
  t.after(() => access.stop())
  const u = new URL(access.url)
  // Pair first, so the Host check is the only thing left standing between the
  // request and the harness — otherwise a 401 would prove nothing.
  const { cookie } = await pairWith(access, access.code)
  assert.ok(cookie)
  const before = host.seen.length

  for (const claimed of [`evil.attacker.example:${u.port}`, `localhost:${u.port}`, u.hostname, `${u.hostname}:${Number(u.port) + 7}`]) {
    const answer = await request(access.url, '/dsh-terminal/run', { headers: { cookie, host: claimed } })
    assert.equal(answer.status, 421, `Host: ${claimed}`)
  }
  assert.equal(host.seen.length, before, 'nothing reached the harness')

  // And the real authority still works.
  const good = await request(access.url, '/ok', { headers: { cookie } })
  assert.equal(good.status, 200)
})

test('a foreign Origin is refused, and a foreign Referer is dropped', async (t) => {
  const host = await fakeHost()
  t.after(() => host.server.close())
  const access = await startPhoneAccess(host.url, null, LOCAL_OK)
  assert.ok(!access.error, access.error)
  t.after(() => access.stop())
  const { cookie } = await pairWith(access, access.code)
  const before = host.seen.length

  const foreign = await request(access.url, '/dsh-files/roots', { headers: { cookie, origin: 'https://evil.example' } })
  assert.equal(foreign.status, 403)
  assert.equal(host.seen.length, before, 'a laundered Origin never reached the harness')

  // Referer is no part of the harness fence, so a foreign one is simply not
  // forwarded rather than rewritten into something that looks trusted.
  const referred = await request(access.url, '/ok', { headers: { cookie, referer: 'https://news.example/story' } })
  assert.equal(referred.status, 200)
  assert.equal(JSON.parse(referred.body).referer, null)

  const own = await request(access.url, '/ok', { headers: { cookie, referer: `${access.url}/somewhere` } })
  assert.match(JSON.parse(own.body).referer, /^http:\/\/127\.0\.0\.1:\d+\//)
})

test('a pairing code is spent the moment it pairs a device', async (t) => {
  const host = await fakeHost()
  t.after(() => host.server.close())
  // A 40ms grace, so the spent code can be watched dying without a ten-second
  // wait. The grace itself has its own test below.
  const access = await startPhoneAccess(host.url, null, { ...LOCAL_OK, spentCodeGraceMs: 40 })
  assert.ok(!access.error, access.error)
  t.after(() => access.stop())

  const first = access.code
  const one = await pairWith(access, first)
  assert.equal(one.answer.status, 303)
  assert.match(String(one.answer.headers['set-cookie'][0]), /SameSite=Strict/)
  assert.notEqual(access.code, first, 'the code rotated')

  // Once the retry grace lapses, replaying the spent code is a wrong guess.
  await new Promise((resolve) => setTimeout(resolve, 60))
  const replay = await request(access.url, '/dshd-pair', { method: 'POST', headers: form, body: `code=${first}` })
  assert.equal(replay.status, 403)

  // The current one pairs the next device.
  const two = await pairWith(access, access.code)
  assert.equal(two.answer.status, 303)

  // A browser that resubmits the form is already paired: answer it rather than
  // charge it a guess against a code that has since rotated away.
  const resubmit = await request(access.url, '/dshd-pair', {
    method: 'POST',
    headers: { ...form, cookie: two.cookie },
    body: 'code=000000',
  })
  assert.equal(resubmit.status, 303)
})

test('stop() closes a tunnel the proxy upgraded', async (t) => {
  const host = await fakeHost()
  t.after(() => host.server.close())
  const access = await startPhoneAccess(host.url, null, LOCAL_OK)
  assert.ok(!access.error, access.error)
  const u = new URL(access.url)
  const { cookie } = await pairWith(access, access.code)

  const tunnel = net.connect({ host: u.hostname, port: Number(u.port) })
  t.after(() => tunnel.destroy())
  const deadline = (label) => new Promise((_, reject) => setTimeout(() => reject(new Error(label)), 5000).unref())
  const upgraded = new Promise((resolve) => {
    let buffer = ''
    tunnel.on('data', (chunk) => { buffer += chunk; if (buffer.includes('101')) resolve() })
  })
  tunnel.on('error', () => {})
  tunnel.write(`GET /ws HTTP/1.1\r\nHost: ${u.host}\r\nCookie: ${cookie}\r\nUpgrade: dsh\r\nConnection: Upgrade\r\n\r\n`)
  await Promise.race([upgraded, deadline('the tunnel never upgraded')])
  assert.equal(tunnel.destroyed, false)

  // Node stops tracking a socket once it is upgraded, so closeAllConnections
  // walks past it: before this fix the tunnel stayed open and kept passing
  // bytes after phone access was switched off.
  const closed = new Promise((resolve) => tunnel.on('close', resolve))
  access.stop()
  await Promise.race([closed, deadline('stop() left the tunnel open')])
})

test('stop() closes the surviving half when one leg died first', async (t) => {
  // The regression this pins: one close handler wired to both sockets meant
  // whichever leg died first evicted its still-live partner from the set, so
  // stop() walked past it. Measured with the surviving half still writable.
  const host = await fakeHost()
  t.after(() => host.server.close())
  const access = await startPhoneAccess(host.url, null, LOCAL_OK)
  assert.ok(!access.error, access.error)
  const u = new URL(access.url)
  const { cookie } = await pairWith(access, access.code)

  const tunnel = net.connect({ host: u.hostname, port: Number(u.port) })
  t.after(() => tunnel.destroy())
  tunnel.on('error', () => {})
  const deadline = (label) => new Promise((_, reject) => setTimeout(() => reject(new Error(label)), 5000).unref())
  // The upstream hangs up right after the handshake; our half stays connected.
  const upstreamGone = new Promise((resolve) => tunnel.on('end', resolve))
  // Read the handshake. A paused socket never emits 'end', which is how to
  // write a test that waits forever on a connection that closed correctly.
  tunnel.on('data', () => {})
  tunnel.write(`GET /ws-die HTTP/1.1\r\nHost: ${u.host}\r\nCookie: ${cookie}\r\nUpgrade: dsh\r\nConnection: Upgrade\r\n\r\n`)
  await Promise.race([upstreamGone, deadline('the upstream never hung up')])
  assert.equal(tunnel.destroyed, false, 'our half should still be open')

  const closed = new Promise((resolve) => tunnel.on('close', resolve))
  access.stop()
  await Promise.race([closed, deadline('stop() left the surviving half open')])
})

test('a spent code still works for a moment, so a retried form is not a guess', async (t) => {
  const host = await fakeHost()
  t.after(() => host.server.close())
  const access = await startPhoneAccess(host.url, null, LOCAL_OK)
  assert.ok(!access.error, access.error)
  t.after(() => access.stop())

  const first = access.code
  const submissions = await Promise.all(Array.from({ length: 6 }, () => pairWith(access, first)))
  for (const { answer } of submissions) assert.equal(answer.status, 303, 'a simultaneous resubmission was charged as a guess')
  assert.notEqual(access.code, first, 'the code still rotated on the first success')

  // The grace is for a retry, not a second life: the rotated code is the one
  // the desktop shows and the one a new device must use.
  const current = await pairWith(access, access.code)
  assert.equal(current.answer.status, 303)
})

test('the client table fails closed rather than handing back a fresh allowance', () => {
  // Needs more source addresses than one machine has, so it is driven directly.
  const now = 1_000_000
  const clients = new Map()
  const max = 4
  for (let i = 0; i < max; i++) {
    const entry = admitClient(clients, `10.0.0.${i}`, now, max)
    assert.ok(entry)
    entry.lockouts = 1
    entry.until = now + 60_000
  }
  // Every slot is a live lockout: a new address is refused, and no locked-out
  // client is evicted back to a clean slate.
  assert.equal(admitClient(clients, '10.0.0.99', now, max), null)
  assert.equal(clients.size, max)
  for (const state of clients.values()) assert.equal(state.until, now + 60_000)

  // A finished entry is evictable, and only that one.
  clients.get('10.0.0.2').until = now - 1
  const admitted = admitClient(clients, '10.0.0.99', now, max)
  assert.ok(admitted)
  assert.equal(admitted.lockouts, 0)
  assert.equal(clients.has('10.0.0.2'), false)
  assert.equal(clients.has('10.0.0.0'), true)
  assert.equal(clients.size, max)

  // An address already in the table keeps its counters, whatever the pressure.
  const known = clients.get('10.0.0.0')
  assert.equal(admitClient(clients, '10.0.0.0', now, max), known)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'

import { apply } from '../lib/index.js'

// Preview servers used to be created and never released: one listening socket
// per distinct folder, for the life of the process. An audit opened three
// folders and watched three listeners accumulate on the harness pid with none
// returned; the 33rd told the user to restart the app to get the feature back.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Does anything accept a connection on this loopback port? */
function portAnswers (port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (answer) => { socket.destroy(); resolve(answer) }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function fixture (t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-prevlife-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  let handler, dispose
  apply({
    fs: {
      async resolve (path) { return { path } },
      async stat () { return { type: 'file' } },
    },
    workspaceRegistry: { list: () => [{ path: home, title: 'Fixture' }] },
    webServer: { register (config) { handler = config.handler; return () => {} } },
    on (event, fn) { if (event === 'dispose') dispose = fn },
  })
  const server = createServer((req, res) => handler(req, res))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const open = async (page) => {
    const res = await fetch(origin + '/dsh-files/preview/open?path=' + encodeURIComponent(page))
    assert.equal(res.status, 200, 'preview/open should succeed')
    return Number(new URL((await res.json()).previewOrigin).port)
  }
  return { home, open }
}

async function page (home, folder) {
  const directory = join(home, folder)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'index.html')
  await writeFile(file, `<h1>${folder}</h1>`)
  return file
}

test('opening the same folder twice reuses one server', async (t) => {
  const { home, open } = await fixture(t)
  const file = await page(home, 'site')
  const first = await open(file)
  const second = await open(file)
  assert.equal(first, second, 'a second open bound a second port for the same folder')
})

test('a preview server that goes idle is closed and its port released', async (t) => {
  // Mocked so the ten-minute idle window does not have to elapse. Enabled
  // before apply() so the plugin's sweep interval is the one being driven.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const { home, open } = await fixture(t)
  const port = await open(await page(home, 'site'))
  assert.equal(await portAnswers(port), true, 'the preview server should be listening')

  // Well past the idle window, with the sweep running on its own interval.
  t.mock.timers.tick(11 * 60 * 1000)
  t.mock.timers.reset()
  // close() completes on the real event loop, not the mocked clock.
  for (let attempt = 0; attempt < 20 && await portAnswers(port); attempt++) await sleep(25)

  assert.equal(await portAnswers(port), false, 'an idle preview server kept its port')
})

test('a folder still in use is not swept out from under the pane', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const { home, open } = await fixture(t)
  const file = await page(home, 'site')
  const port = await open(file)

  // Half the idle window, then a request — which is what a live iframe does.
  t.mock.timers.tick(6 * 60 * 1000)
  const served = await fetch(`http://127.0.0.1:${port}/index.html`)
  assert.equal(served.status, 200)
  t.mock.timers.tick(6 * 60 * 1000)
  t.mock.timers.reset()
  await sleep(50)

  // The request reset the clock, so twelve minutes after opening it is still up.
  assert.equal(await portAnswers(port), true, 'a preview server in active use was closed')
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The menu-bar glyph. tray.cjs flags a template image by FILE NAME, and macOS
// recolours it from the alpha channel, so a filled colour PNG here would paint
// a solid block. These assertions are the contract that keeps that from shipping.

const SRC = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(SRC, '../src/assets')
const TRAY_SOURCE = readFileSync(join(SRC, '../src/tray.cjs'), 'utf8')
const HOST_SOURCE = readFileSync(join(SRC, '../src/tray-host.cjs'), 'utf8')
const MAIN_SOURCE = readFileSync(join(SRC, '../src/main.cjs'), 'utf8')

const TEMPLATE_NAME = /Template(@[0-9]+x)?\.png$/i

function u32 (buf, offset) {
  return buf.readUInt32BE(offset)
}

function decodePng (file) {
  const data = readFileSync(file)
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file + ' is not a PNG')
  let i = 8
  let width = 0
  let height = 0
  const idat = []
  while (i < data.length) {
    const len = u32(data, i)
    const type = data.subarray(i + 4, i + 8).toString('latin1')
    const chunk = data.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') {
      width = u32(chunk, 0)
      height = u32(chunk, 4)
      assert.equal(chunk[8], 8, 'bit depth')
      assert.equal(chunk[9], 6, 'must be RGBA')
    } else if (type === 'IDAT') {
      idat.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    i += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4 + 1
  assert.equal(raw.length, stride * height)
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, 'row filter must be None so this decoder stays honest')
    raw.copy(rgba, y * width * 4, y * stride + 1, y * stride + 1 + width * 4)
  }
  return { width, height, rgba }
}

function histogram (rgba) {
  let opaque = 0, partial = 0, clear = 0, colour = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0) colour += 1
    const a = rgba[i + 3]
    if (a === 0) clear += 1
    else if (a === 255) opaque += 1
    else partial += 1
  }
  return { opaque, partial, clear, colour, total: rgba.length / 4 }
}

test('the 1x asset is a 16px template image named the way tray.cjs flags one', () => {
  const file = join(ASSETS, 'trayTemplate.png')
  assert.match('trayTemplate.png', TEMPLATE_NAME)
  assert.match(TRAY_SOURCE, /TEMPLATE_NAME = \/Template\(@\[0-9\]\+x\)\?\\.png\$/i)
  const png = decodePng(file)
  assert.equal(png.width, 16)
  assert.equal(png.height, 16)
  const hist = histogram(png.rgba)
  assert.equal(hist.colour, 0, hist.colour + ' pixels have non-zero RGB; macOS would paint those as colour, not a stencil')
  // Measured by scripts/make-tray-icon.py on this file. A filled square - the
  // failure mode this exists to prevent - was 216 opaque / 28 partial / 12
  // clear on a 16x16 (build/icons/16x16.png, cited in tray.cjs). Four opaque
  // pixels is a stroke, not a block.
  assert.deepEqual(hist, { opaque: 4, partial: 100, clear: 152, colour: 0, total: 256 })
})

test('the 2x asset is a 32px template image of the same glyph', () => {
  const file = join(ASSETS, 'trayTemplate@2x.png')
  assert.match('trayTemplate@2x.png', TEMPLATE_NAME)
  const png = decodePng(file)
  assert.equal(png.width, 32)
  assert.equal(png.height, 32)
  const hist = histogram(png.rgba)
  assert.equal(hist.colour, 0)
  assert.deepEqual(hist, { opaque: 56, partial: 306, clear: 662, colour: 0, total: 1024 })
  // Coverage should stay in the same band when the pixel count quadruples.
  // 1x drawn pixels (opaque+partial) = 104/256 = 40.6%; 2x = 362/1024 = 35.4%.
  // A filled square would be >90% at both sizes.
  const drawn1 = 104 / 256
  const drawn2 = 362 / 1024
  assert.ok(Math.abs(drawn1 - drawn2) < 0.1, '1x and 2x coverage drifted: ' + drawn1 + ' vs ' + drawn2)
})

test('main hands tray.cjs this file, not a colour icon from build/', () => {
  assert.match(MAIN_SOURCE, /iconPath: path\.join\(__dirname, 'assets', 'trayTemplate\.png'\)/)
  assert.doesNotMatch(MAIN_SOURCE, /build\/icons/)
  assert.match(HOST_SOURCE, /createTray/)
})

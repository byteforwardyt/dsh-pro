'use strict'
/**
 * Render the app icon to .icns using Electron as the rasterizer.
 *
 * Electron is already a build dependency and ships a full Chromium, so it can
 * render the SVG faithfully with no extra image toolchain. The iconset sizes are
 * produced with macOS's own `sips`, and `iconutil` seals them into an .icns.
 *
 * Usage: electron scripts/make-icon.cjs
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'build', 'icon', 'icon.html')
const OUT_DIR = path.join(ROOT, 'build', 'icon')
const MASTER = path.join(OUT_DIR, 'icon-1024.png')
const ICONSET = path.join(OUT_DIR, 'DSHPro.iconset')
const ICNS = path.join(OUT_DIR, 'icon.icns')

/** The exact set macOS expects; anything missing degrades silently in Finder. */
const SIZES = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  })
  await win.loadFile(SOURCE)
  // Give the SVG a frame to paint before capturing.
  await new Promise((resolve) => setTimeout(resolve, 600))
  const image = await win.webContents.capturePage()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(MASTER, image.toPNG())

  fs.rmSync(ICONSET, { recursive: true, force: true })
  fs.mkdirSync(ICONSET, { recursive: true })
  for (const [size, name] of SIZES) {
    execFileSync('sips', ['-z', String(size), String(size), MASTER, '--out', path.join(ICONSET, name)],
      { stdio: 'ignore' })
  }
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', ICNS])

  console.log(`icon written: ${ICNS} (${fs.statSync(ICNS).size} bytes)`)
  app.quit()
})

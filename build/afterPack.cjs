'use strict'
/**
 * afterPack: copy the staged harness closure into the packaged app.
 *
 * electron-builder's extraResources/extraFiles filtering excludes node_modules
 * trees, so the 270 MB harness closure never lands via config. Copying it here —
 * after electron-builder has assembled the .app but before signing — is the
 * reliable path: it bypasses the file matcher entirely and puts real files (not
 * symlinks) at Contents/Resources/harness, which is where the packaged main
 * resolves the dsh entry and our plugins.
 *
 * Signing runs AFTER this hook, so every Mach-O binary copied here is included
 * in the hardened-runtime signing pass (see build/afterSign for the deep-sign
 * that notarization requires).
 */
const fs = require('node:fs')
const path = require('node:path')

/** Dev artifacts that leak into the staged tree from the shell package. */
const SKIP = new Set(['.captures', 'run.log', '.DS_Store'])

exports.default = async function afterPack (context) {
  const { appOutDir, packager, arch } = context
  const archName = { 0: 'ia32', 1: 'x64', 3: 'arm64' }[arch] ?? 'arm64'
  // electron-builder names the OS 'darwin' | 'linux' | 'win32' here, matching
  // the staging directory convention and node's process.platform.
  const plat = context.electronPlatformName || 'darwin'
  const source = path.join(__dirname, '..', 'staging', `${plat}-${archName}`)
  if (!fs.existsSync(source)) {
    throw new Error(`afterPack: staged harness not found at ${source}. Run: node scripts/stage-harness.cjs --platform ${plat} --arch ${archName}`)
  }

  const appName = packager.appInfo.productFilename
  // Resources live under the app bundle on macOS, and directly under the packed
  // dir on Linux/Windows. The packaged main resolves Resources/harness the same
  // way on all three (process.resourcesPath).
  const dest = plat === 'darwin'
    ? path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'harness')
    : path.join(appOutDir, 'resources', 'harness')
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })

  let count = 0
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const src = path.join(from, entry.name)
      const dst = path.join(to, entry.name)
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true })
        copy(src, dst)
      } else if (entry.isSymbolicLink()) {
        // The staging step already dereferenced links; any left is a real target.
        fs.copyFileSync(fs.realpathSync(src), dst)
        count++
      } else {
        fs.copyFileSync(src, dst)
        // Preserve the executable bit (node-pty's spawn-helper, koffi, etc.).
        try { fs.chmodSync(dst, fs.statSync(src).mode) } catch {}
        count++
      }
    }
  }
  copy(source, dest)

  // Sanity: the entry the packaged main will spawn must exist.
  const entry = path.join(dest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(entry)) throw new Error(`afterPack: harness entry missing after copy: ${entry}`)
  console.log(`  • afterPack: staged harness copied (${count} files) -> Resources/harness`)
  if (plat === process.platform && archName === process.arch) {
    const runtime = plat === 'darwin'
      ? path.join(appOutDir, `${appName}.app`, 'Contents', 'MacOS', appName)
      : path.join(appOutDir, (packager.executableName || appName) + (plat === 'win32' ? '.exe' : ''))
    await require('../scripts/smoke-packaged-host.cjs').smokePackagedHost(runtime, dest)
  }
}

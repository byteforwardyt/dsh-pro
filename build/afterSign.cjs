'use strict'
/**
 * Notarize and staple each .app after electron-builder signs it, before the DMG
 * is built around it.
 *
 * Order is the whole point. Notarizing only the finished DMG gets you a ticket
 * stapled to the disk image, but the .app INSIDE it still has none — so when a
 * user drags the app to /Applications, Gatekeeper has to ask Apple over the
 * network. It passes (verified: `spctl --assess --type execute` returns
 * "accepted, source=Notarized Developer ID"), right up until someone is offline
 * or Apple's service is slow, and then a first launch fails for reasons the
 * user cannot act on. Stapling the app here means the ticket travels with it.
 *
 * Gated on DSHPRO_NOTARIZE, because this costs an upload and several minutes of
 * Apple queue per architecture. A routine local build should not depend on the
 * network, and should not fail because a keychain profile is missing.
 *
 *   DSHPRO_NOTARIZE=1 npm run pack
 *
 * notarytool does not accept a bare .app — it takes .zip, .pkg or .dmg — so the
 * bundle is zipped with ditto first. `--keepParent` matters: without it the zip
 * contains the bundle's contents rather than the bundle, and the service
 * rejects it.
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PROFILE = process.env.DSHPRO_NOTARY_PROFILE || 'dshpro-notary'

/**
 * How to authenticate to the notary service.
 *
 * Prefer an App Store Connect API key passed by path, and fall back to a
 * keychain profile. The keychain is the fragile option, not the convenient
 * one: writing or reading a notarytool profile can require a user-consent
 * prompt, and a build running from a non-interactive shell gets
 * "An error occurred while accessing the keychain. User interaction is not
 * allowed." — which is exactly how this failed mid-release. A key on disk has
 * no such dependency, and it is also the only form that works in CI.
 *
 *   DSHPRO_NOTARY_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXX.p8
 *   DSHPRO_NOTARY_KEY_ID=XXXX
 *   DSHPRO_NOTARY_ISSUER=<uuid>
 */
function authArgs () {
  const key = process.env.DSHPRO_NOTARY_KEY
  const keyId = process.env.DSHPRO_NOTARY_KEY_ID
  const issuer = process.env.DSHPRO_NOTARY_ISSUER
  if (key && keyId && issuer) {
    return ['--key', key.replace(/^~(?=\/)/, os.homedir()), '--key-id', keyId, '--issuer', issuer]
  }
  return ['--keychain-profile', PROFILE]
}

exports.default = async function afterSign (context) {
  if (!process.env.DSHPRO_NOTARIZE) {
    console.log('  • afterSign: notarization skipped (set DSHPRO_NOTARIZE=1 to enable)')
    return
  }
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  if (!fs.existsSync(appPath)) {
    throw new Error(`afterSign: no app at ${appPath}`)
  }

  const zipPath = path.join(os.tmpdir(), `dshpro-notarize-${process.pid}-${path.basename(context.appOutDir)}.zip`)
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  try {
    console.log(`  • afterSign: zipping ${appName} for notarization`)
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath])

    console.log('  • afterSign: submitting to Apple (this waits on their queue)')
    const out = run('xcrun', ['notarytool', 'submit', zipPath, ...authArgs(), '--wait'])
    const status = (/status:\s*(\w+)/.exec(out.split('Processing complete').pop() || out) || [])[1]
    if (status !== 'Accepted') {
      const id = (/id:\s*([0-9a-f-]{36})/.exec(out) || [])[1]
      throw new Error(
        `afterSign: notarization returned ${status || 'no status'}.\n` +
        (id ? `Details: xcrun notarytool log ${id} <same auth args>\n` : '') + out,
      )
    }

    run('xcrun', ['stapler', 'staple', appPath])
    console.log(`  • afterSign: ${appName} notarized and stapled`)
  } finally {
    fs.rmSync(zipPath, { force: true })
  }
}

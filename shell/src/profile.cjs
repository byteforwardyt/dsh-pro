'use strict'
/**
 * Provisions the `dsh-pro` profile inside $DSH_HOME.
 *
 * Only the `web` and `headless` profiles auto-initialize from shipped templates;
 * any other name must be created by its owner, so the desktop app writes its own.
 * Owning the profile is what lets us compose plugins the stock `web` profile does
 * not carry, while replacing upstream authorization with our allowlisted service.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { claudeMcpPatch } = require('./claude-mcp.cjs')
const { ensureDefaultAgent } = require('./default-agent.cjs')
const { migrateSettings, preflightLegacy } = require('./upstream-migration.cjs')

const PROFILE_NAME = 'dsh-pro'

/**
 * The composition delta over dsh-base + dsh-web-app.
 *
 * Upstream 0.2 mounts `authorization`. Disable that entry and insert our
 * allowlisted subclass rather than mounting a second authorization service — one
 * service, one provider — so only vetted providers can register a login at all.
 *
 * The `hmr` row is deliberately left ENABLED. Disabling it does not avoid the
 * Electron `--expose-internals` requirement; profile-boot mints a replacement HMR
 * entry whenever `ctx.get('hmr')` is undefined, which throws identically. The
 * launcher passes the flag instead (see host-process.cjs).
 */
const PROFILE_PATCH = `# DSH PRO composition layer, applied over dsh-base and dsh-web-app.
#
# Managed by the app: edits are overwritten on launch. Put personal overrides in
# the home-level patch ($DSH_HOME/cordis.patch.yml), which composes after this one.

- id: authorization
  disabled: true

- id: session-log-deepseek
  config:
    enabled: false
- id: desktop-product-telemetry
  disabled: true
- id: product-analytics
  disabled: true

- insert:
    - id: desktop-authorization
      name: '@dsh-desktop/auth-allowlist'
    - id: desktop-schedule
      name: '@deepseek-ai/dsh-schedule'
    # Our authorization subclass registers only explicitly vetted login flows.

    # HTTP surface for the authorization seam: account state, login attempts,
    # and an SSE stream of notices and prompts. Upstream's apiproxy RpcMethodMap
    # is compile-locked, so this registers its own prefix route instead.
    - id: auth-api
      name: '@dsh-desktop/host-auth-api'

    # Tool-failure reporting and redundant Full-access escalation cleanup.
    - id: host-diagnostics
      name: '@dsh-desktop/host-diagnostics'

    # Workspace file access for the Files view: list, read, write, and serve
    # bytes so media can play. Scoped to the open workspace; see the plugin.
    - id: files-api
      name: '@dsh-desktop/host-files-api'

    # Reset-the-app row in Settings > General (desktop only; native confirm).
    - id: ui-reset
      name: '@dsh-desktop/client-ui-reset'

    # Phone-access row in Settings > General (paired LAN proxy, desktop only).
    - id: ui-phone
      name: '@dsh-desktop/client-ui-phone'

    # A Preview view (a local-dev-server browser) beside Chat and Trajectory.
    - id: ui-preview
      name: '@dsh-desktop/client-ui-preview'

    # A Files view: browse the workspace, edit text, play media in place.
    - id: ui-files
      name: '@dsh-desktop/client-ui-files'

    # Terminal dock: interactive PTY shell plus the agent-command transcript.
    # Agent commands keep their existing completion protocol and shared history.
    - id: terminal
      name: '@dsh-desktop/terminal'

    # Session-independent access to the existing Files and Preview components.
    - id: ui-workspace-tools
      name: '@dsh-desktop/client-ui-workspace-tools'

    - id: ui-inspector
      name: '@dsh-desktop/client-ui-inspector'

    - id: ui-media
      name: '@dsh-desktop/client-ui-media'
    - id: computer-use
      name: '@dsh-desktop/computer-use'
    - id: development-setup
      name: '@dsh-desktop/development-setup'

    # A Usage settings page: tokens spent, by model and by day, folded out of
    # the durable session logs so it covers every provider.
    - id: ui-usage
      name: '@dsh-desktop/client-ui-usage'

    # Workspaces settings: pin projects to the top of the sidebar.
    - id: ui-workspaces
      name: '@dsh-desktop/client-ui-workspaces'

    # Our own brand: the holographic whale mark and "DSH PRO" wordmark,
    # filling the same brand slots the stock official-brand package fills.
    - id: ui-brand
      name: '@dsh-desktop/client-ui-brand'

    # Desktop presentation: neutral light/dark tokens and workspace layout.
    # Keep the original package id for saved-profile compatibility.
    - id: ui-theme-holo
      name: '@dsh-desktop/client-ui-theme-holo'

    - id: ui-byteforward
      name: '@dsh-desktop/client-ui-byteforward'

    # The Accounts settings section. It occupies the settings.section slot, so
    # the stock Models page is untouched and its e2e goldens do not move.
    - id: ui-accounts
      name: '@dsh-desktop/client-ui-accounts'

    - id: desktop-model-visibility
      name: '@dsh-desktop/client-ui-model-visibility'

    - id: desktop-agent-default
      name: '@dsh-desktop/client-ui-agent-default'

    - id: desktop-supercode
      name: '@dsh-desktop/client-ui-supercode'

    # OS notifications and the Dock badge: a session waiting on a person, and
    # a turn that finished while the app was in the background. Desktop only,
    # and honest about it - without the shell bridge it renders nothing and
    # watches nothing.
    - id: ui-notify
      name: '@dsh-desktop/client-ui-notify'

# ── The default model ──────────────────────────────────────────────────────
# dsh-base composes agent-default-model as deepseek-official/deepseek-v4-flash.
# That is correct for DeepSeek's own build and wrong for this one: this is the
# provider-agnostic edition, it ships no DeepSeek credential, and it offers
# sign-in for ChatGPT, Grok, Kimi and OpenRouter — so the stock default pointed
# every new session at a provider the user had not configured and could not use
# without going to get a key from a vendor this app never mentioned.
#
# The replacement is not an endorsement of another vendor. The schema requires
# a provider, and the only defensible choice is one this build can actually
# authenticate; host-auth-api then retargets the default to whichever account
# the user really connects (lib/default-model.js), so this value is a starting
# point that corrects itself and never a destination.
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: openai-codex
    model: gpt-5.6-luna

- id: agent-preset-registry
  config:
    default: dsh-agent

# Native DeepSeek stays available for existing configured connections. Fresh
# profiles can choose DeepSeek through Models > Add provider like any vendor.
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  disabled: true
- id: llm-deepseek-account
  disabled: true
- insert:
    - id: optional-deepseek
      name: '@dsh-desktop/host-auth-api/optional-deepseek'
`

const PROFILE_ROOT = `# dsh profile root — composed from bundle patches; do not edit.
[]
`

const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

function profileManifest (previous = {}) {
  return JSON.stringify({
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: previous.dependencies || {},
    dsh: {
      profile: {
        bundles: [...new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-desktop/profile', ...(previous.dsh?.profile?.bundles || [])])],
      },
    },
  }, null, 2) + '\n'
}

/**
 * The harness heals `$DSH_HOME/profiles/node_modules` with ABSOLUTE symlinks into
 * the installation directory. That directory moves when the app is moved between
 * /Applications and ~/Applications, when it is updated, and on every launch under
 * macOS App Translocation. Stale links resolve to nothing and the boot fails with
 * a bare specifier error, so the link farm is rebuilt whenever the anchor changes.
 *
 * Keyed on the install path, NOT the app version: moving the app does not change
 * its version, and that is the common case.
 */
function resetLinkFarmIfMoved (dshHome, installAnchor) {
  const marker = path.join(dshHome, '.install-anchor')
  const digest = crypto.createHash('sha256').update(installAnchor).digest('hex').slice(0, 16)
  let previous = null
  try { previous = fs.readFileSync(marker, 'utf8').trim() } catch {}
  if (previous === digest) return false

  fs.rmSync(path.join(dshHome, 'profiles', 'node_modules'), { recursive: true, force: true })
  fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(marker, `${digest}\n`, { mode: 0o600 })
  return true
}

/**
 * Make an out-of-tree plugin resolvable from the profile.
 *
 * Plugin specifiers resolve from the profile directory upward. The harness heals
 * `profiles/node_modules` with its OWN dependency closure, which does not include
 * our packages, so we link ours into the profile's private `node_modules` instead:
 * it wins the resolution walk and sits outside the directory the healer manages,
 * so the two never contend.
 *
 * Node resolves a symlinked module against its REAL path, so the plugin's own
 * dependencies keep resolving through its real node_modules.
 */
function linkPlugin (profileDir, packageName, realDir) {
  const target = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let current = null
  try { current = fs.readlinkSync(target) } catch {}
  if (current === realDir) return
  fs.rmSync(target, { recursive: true, force: true })
  fs.symlinkSync(realDir, target, 'dir')
}

/**
 * Write the profile if absent, and refresh the managed files we own.
 * @param {string} dshHome
 * @param {string} installAnchor - path whose change invalidates the link farm.
 * @param {Record<string,string>} plugins - package name -> resolved directory.
 * @returns {{ name: string, dir: string, relinked: boolean }}
 */
function ensureProfile (dshHome, installAnchor, plugins = {}) {
  preflightLegacy(dshHome)
  const relinked = resetLinkFarmIfMoved(dshHome, installAnchor)
  const dir = path.join(dshHome, 'profiles', PROFILE_NAME)
  fs.mkdirSync(dir, { recursive: true })

  const bundleDir = path.join(dir, 'node_modules', '@dsh-desktop', 'profile')
  fs.mkdirSync(bundleDir, { recursive: true })
  writeIfChanged(path.join(bundleDir, 'package.json'), JSON.stringify({
    name: '@dsh-desktop/profile', version: '0.1.50', private: true,
    dsh: { bundle: { patch: ['./desktop.patch.yml', './agent.patch.yml', './dispatch.patch.yml'] } },
  }, null, 2))
  writeIfChanged(path.join(bundleDir, 'desktop.patch.yml'), PROFILE_PATCH + claudeMcpPatch())
  ensureDefaultAgent(dshHome, installAnchor, bundleDir)

  // package.json and the patch are ours; rewrite them so an app update can change
  // the composition. cordis.yml is a fixed empty root.
  const manifestFile = path.join(dir, 'package.json')
  const previous = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {}
  writeIfChanged(manifestFile, profileManifest(previous))
  const userPatch = path.join(dir, 'cordis.patch.yml')
  if (fs.existsSync(userPatch) && fs.readFileSync(userPatch, 'utf8').startsWith('# DSH PRO composition layer')) {
    const backup = path.join(dir, 'cordis.patch.pre-0.2.yml')
    if (fs.existsSync(backup)) throw new Error('Profile backup already exists; refusing to overwrite it.')
    fs.renameSync(userPatch, backup)
  }
  if (!fs.existsSync(userPatch)) writeIfChanged(userPatch, '[]\n')
  migrateSettings(dshHome, dir, installAnchor)
  writeIfChanged(path.join(dir, 'cordis.yml'), PROFILE_ROOT)
  writeIfChanged(path.join(dir, 'pnpm-workspace.yaml'), PROFILE_WORKSPACE)

  for (const [packageName, realDir] of Object.entries(plugins)) {
    linkPlugin(dir, packageName, realDir)
  }

  return { name: PROFILE_NAME, dir, relinked }
}

function writeIfChanged (file, contents) {
  try {
    if (fs.readFileSync(file, 'utf8') === contents) return
  } catch {}
  fs.writeFileSync(file, contents)
}

module.exports = { ensureProfile, PROFILE_NAME }

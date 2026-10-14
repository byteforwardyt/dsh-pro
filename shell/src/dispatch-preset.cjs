'use strict'
/**
 * Write the "Dispatch" agent preset into the harness home.
 *
 * A mode in this product is an agent preset — a directory under a preset root
 * holding `agent.cordis.yml` (the composition) and `preset.yml` (its label).
 * The shipped presets (Standard, PTC, Minimal, Creator) live read-only inside
 * the harness; the one writable root is `$DSH_HOME/.agent-presets`, discovered
 * automatically. So this authors our Dispatch mode there.
 *
 * The composition is NOT a hand-copied fork of Standard. It is the SHIPPED
 * standard composition read at launch, with two rows appended: the dispatch
 * tool, and a prompt section that explains it. Generating it from the installed
 * standard means Dispatch mode is "a full coding agent plus the ability to hand
 * work to other agents", and it tracks whatever Standard becomes across upstream
 * bumps rather than drifting from it.
 */

const fs = require('node:fs')
const path = require('node:path')

/** The extra rows that turn a standard agent into a dispatcher. */
const DISPATCH_ROWS = `
# ── Dispatch: hand a task to another installed coding-agent CLI ───────────────
# One extra tool on top of the full standard agent. It registers a tool and
# publishes no Service, so it needs no isolate realm. The tool's own model-facing
# description carries the how/when guidance and the untrusted-output framing, so
# no separate prompt-section row is needed (dsh-agent-instructions is for
# AGENTS.md loading, not free prompt text).
- id: dispatch-tool
  name: '@dsh-desktop/tool-dispatch'
`

/**
 * Locate the shipped `standard` preset composition, from the harness entry.
 * @param harnessDir - directory of the resolved dsh entry (already known to main).
 * @returns the composition text, or null if it cannot be found.
 */
function readStandardComposition (harnessDir) {
  const candidates = []
  try {
    // @deepseek-ai/dsh ships config/agent-presets/standard beside its lib.
    const dshPkg = require.resolve('@deepseek-ai/dsh/package.json', { paths: [harnessDir] })
    candidates.push(path.join(path.dirname(dshPkg), 'config', 'agent-presets', 'standard', 'agent.cordis.yml'))
  } catch { /* fall through */ }
  for (const file of candidates) {
    try { return fs.readFileSync(file, 'utf8') } catch { /* next */ }
  }
  return null
}

/**
 * Author (or refresh) the Dispatch preset.
 *
 * Idempotent and overwriting: the composition is regenerated from the shipped
 * standard every launch, so a harness bump that changes standard flows straight
 * into Dispatch. Never touches any other preset directory.
 *
 * @param dshHome - $DSH_HOME.
 * @param harnessDir - directory of the resolved harness entry.
 * @returns 'written' | 'skipped' with a reason.
 */
function ensureDispatchPreset (dshHome, harnessDir) {
  const standard = readStandardComposition(harnessDir)
  if (standard === null) return { status: 'skipped', reason: 'standard composition not found' }

  const dir = path.join(dshHome, '.agent-presets', 'dispatch')
  const composition = standard.replace(/\s*$/, '\n') + DISPATCH_ROWS
  const metadata =
    'name: Dispatch\n'
    + 'description: Chat normally and have the agent hand tasks to other coding-agent CLIs installed on this Mac.\n'
    + 'order: 5\n'

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'agent.cordis.yml'), composition)
    fs.writeFileSync(path.join(dir, 'preset.yml'), metadata)
    return { status: 'written', dir }
  } catch (error) {
    return { status: 'skipped', reason: error.message }
  }
}

module.exports = { ensureDispatchPreset }

'use strict'
/**
 * Materialise the harness runtime closure into a symlink-free tree for packaging.
 *
 * Two problems this solves, both of which silently ship a broken app otherwise:
 *
 * 1. **pnpm symlinks.** The workspace store is a farm of symlinks. electron-builder
 *    has improved here, but the repo also uses `link:` overrides, and the harness
 *    itself writes absolute junctions into $DSH_HOME/profiles/node_modules at
 *    runtime. A real-file tree sidesteps all of it. Use
 *    pnpm's shared-lockfile deployment, then dereference. Legacy hoisted deploy
 *    ignores the lockfile and silently upgrades runtime dependencies.
 *
 * 2. **Per-architecture native packages.** koffi, sharp and node-addon-require-builtin
 *    resolve to `<name>-darwin-arm64` / `-darwin-x64` optional dependencies, and pnpm
 *    installs ONLY the ones matching the current machine. node-pty is the exception —
 *    it ships every prebuild in one tarball, which masks the problem during testing.
 *    A universal build merged from a single staging tree therefore produces an
 *    arm64-only binary that dies on Intel with MODULE_NOT_FOUND. So: never
 *    cross-build, and assert the expected binaries exist before packaging.
 *
 *   node scripts/stage-harness.cjs [--arch arm64|x64] [--out <dir>]
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const platform = arg('platform', 'darwin')
const arch = arg('arch', process.arch)
if (!['darwin', 'linux', 'win32'].includes(platform)) {
  throw new Error(`--platform must be darwin, linux or win32 (got ${platform})`)
}
const outDir = path.resolve(arg('out', path.join(ROOT, 'staging', `${platform}-${arch}`)))

/**
 * The per-platform+arch suffix each native optional dependency is published
 * under. The convention is mostly `-<platform>-<arch>`, but node-addon-require-
 * builtin adds a libc/toolchain tag: `-gnu` on Linux, `-msvc` on Windows.
 */
const NARB_SUFFIX = { darwin: '', linux: '-gnu', win32: '-msvc' }[platform]

/**
 * Native packages that resolve per platform+arch. Each entry is the directory we
 * expect to find in the staged tree for the target we are building.
 */
const REQUIRED_NATIVE = [
  `@trycua/cua-driver-${platform}-${arch}${platform === 'linux' ? '-gnu' : platform === 'win32' ? '-msvc' : ''}`,
  `@koromix/koffi-${platform}-${arch}`,
  `node-addon-require-builtin-${platform}-${arch}${NARB_SUFFIX}`,
  `@img/sharp-${platform}-${arch}`,
  // sharp's actual image codepath lives in libvips, a separate 17-19MB package
  // that the first prune pass missed entirely because it is a sibling rather
  // than the same package name.
  `@img/sharp-libvips-${platform}-${arch}`,
  // The agent's file search shells out to this. A wrong-arch rg does not fail
  // the build, it fails the first search the user runs.
  `@vscode/ripgrep-${platform}-${arch}`,
]

/**
 * node-pty ships all prebuilds in one tarball; check the ones we actually need.
 * Only macOS carries a separate spawn-helper binary; Linux and Windows do not.
 */
const REQUIRED_FILES = [
  path.join('node_modules', 'node-pty', 'prebuilds', `${platform}-${arch}`, 'pty.node'),
]
if (platform === 'darwin') {
  REQUIRED_FILES.push(path.join('node_modules', 'node-pty', 'prebuilds', `${platform}-${arch}`, 'spawn-helper'))
}

/**
 * Cross-arch staging is refused unless the target's native packages are really
 * installed.
 *
 * This used to refuse ANY cross-arch build, on the reasoning that pnpm installs
 * only the host architecture's native optional dependencies. That reasoning was
 * right about the danger and wrong about the rule: the danger is a staged tree
 * MISSING the target's koffi/sharp/node-addon binaries, which produces a binary
 * that launches here and dies on the target with MODULE_NOT_FOUND. Host arch is
 * only a proxy for that.
 *
 * `supportedArchitectures` in pnpm-workspace.yaml now installs both macOS
 * slices, so the proxy is wrong in the one case we care about. Check the real
 * thing instead: are the target's native packages on disk to be staged? If they
 * are, cross-staging is safe. If they are not, refuse exactly as before —
 * including when someone drops supportedArchitectures.
 */
function assertTargetInstalled () {
  // The host tool runs on macOS; it cross-stages other targets from here. What
  // matters is not the host but whether the TARGET's native packages are really
  // in the store to be copied — a staged tree missing them launches here and
  // dies on the target with MODULE_NOT_FOUND.
  const isHostTarget = platform === 'darwin' && arch === process.arch
  if (isHostTarget) return

  const missing = REQUIRED_NATIVE.filter((pkg) => {
    // pnpm's store nests each package under its own hashed directory, so glob
    // the store rather than guessing a hoisted path.
    const store = path.join(ROOT, 'node_modules', '.pnpm')
    if (!fs.existsSync(store)) return true
    return !fs.readdirSync(store).some((dir) =>
      fs.existsSync(path.join(store, dir, 'node_modules', ...pkg.split('/'))))
  })

  if (missing.length) {
    throw new Error(
      `refusing to cross-build for ${platform}-${arch}: the target's native packages\n` +
      `are not installed:\n  ` + missing.join('\n  ') + '\n\n' +
      'The staged tree would be missing them and would fail at runtime on the target.\n' +
      'Add the target to pnpm-workspace.yaml supportedArchitectures (os/cpu/libc),\n' +
      `then re-run pnpm install. Or run this on a ${platform}-${arch} machine.`,
    )
  }

  console.log(`cross-staging ${platform}-${arch} from a ${process.platform}-${process.arch} host; `
    + `all ${REQUIRED_NATIVE.length} target native packages are installed`)
}

/** Replace every symlink under `dir` with a real copy of its target. */
function materialiseLinks (dir) {
  let replaced = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(full)
        const stat = fs.statSync(resolved)
        fs.rmSync(full, { recursive: true, force: true })
        fs.cpSync(resolved, full, { recursive: stat.isDirectory(), dereference: true })
        replaced += 1
        continue
      }
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return replaced
}

/**
 * Drop native packages belonging to the OTHER architecture.
 *
 * `supportedArchitectures` installs both macOS slices so that cross-staging is
 * possible at all, and `pnpm deploy` faithfully copies both into every staged
 * tree. Shipping the wrong one is not a correctness problem — the resolver
 * picks by process.arch and never loads it — but it is ~30MB of dead binary in
 * each DMG, and it makes "which arch is this tree?" unanswerable by inspection.
 *
 * Pruning is safe precisely because these are optional dependencies: an absent
 * one is the normal, supported state on a platform that does not use it.
 * verify() runs AFTER this and still demands the target's own packages, so a
 * prune that removed the wrong side would fail the build rather than ship.
 */
function pruneForeignNative () {
  const root = path.join(outDir, 'node_modules')
  if (!fs.existsSync(root)) return

  // Scan for the naming convention rather than listing packages by hand. The
  // hand-written list once missed @img/sharp-libvips-darwin-x64 — the single
  // largest foreign binary — because it is a sibling package rather than the
  // same name. Matching the suffix catches that one and any future addition
  // that follows the convention: `-<platform>-<arch>` with an optional libc
  // tag (koffi/sharp/ripgrep, and node-addon-require-builtin's -gnu/-msvc).
  // A package is a foreign native variant when it names SOME platform+arch
  // other than the target we are staging. `linuxmusl` is its OWN platform token,
  // distinct from `linux` (glibc): on a glibc AppImage the musl sharp/libvips
  // builds are ~36MB of never-loaded dead weight, so they must be pruned too.
  const VARIANT = /-(darwin|linuxmusl|linux|win32)-(arm64|x64|ia32)(-gnu|-msvc)?$/
  const victims = []
  const scan = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.name.startsWith('@') && !prefix) { scan(path.join(dir, entry.name), entry.name); continue }
      const m = entry.name.match(VARIANT)
      if (m && !(m[1] === platform && m[2] === arch)) {
        victims.push({ name, dir: path.join(dir, entry.name) })
      }
    }
  }
  scan(root, '')

  let freed = 0
  for (const victim of victims) {
    try {
      freed += Number(execFileSync('du', ['-sk', victim.dir], { encoding: 'utf8' }).split('\t')[0]) || 0
    } catch {}
    fs.rmSync(victim.dir, { recursive: true, force: true })
  }
  if (victims.length) {
    console.log(`pruned ${victims.length} foreign-arch package(s), ~${Math.round(freed / 1024)}MB: `
      + victims.map((v) => v.name).join(', '))
  }
}

function verify () {
  const missing = []
  for (const pkg of REQUIRED_NATIVE) {
    if (!fs.existsSync(path.join(outDir, 'node_modules', ...pkg.split('/')))) missing.push(pkg)
  }
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(outDir, file))) missing.push(file)
  }
  // macOS only: the spawn-helper must keep its exec bit (a copy through a
  // non-preserving step strips it, and node-pty then cannot spawn a PTY).
  if (platform === 'darwin' && REQUIRED_FILES[1]) {
    const helper = path.join(outDir, REQUIRED_FILES[1])
    if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) {
      missing.push(`${REQUIRED_FILES[1]} (present but not executable)`)
    }
  }
  if (missing.length) {
    throw new Error(
      `staged tree is incomplete for ${platform}-${arch}:\n  ` + missing.join('\n  ') +
      '\n\nThis is the silent-broken-binary case: it would launch on this machine and\n' +
      'fail on the target. Do not package this tree.',
    )
  }
}

assertTargetInstalled()
// pnpm otherwise falls back to an unlocked install when the lockfile is absent.
fs.accessSync(path.join(ROOT, 'pnpm-lock.yaml'), fs.constants.R_OK)
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(path.dirname(outDir), { recursive: true })

console.log(`staging harness closure for ${platform}-${arch} -> ${outDir}`)
execFileSync('pnpm', [
  '--filter', '@dsh-desktop/shell',
  'deploy', '--prod', '--config.inject-workspace-packages=true',
  '--config.node-linker=hoisted',
  outDir,
], { cwd: ROOT, stdio: 'inherit' })

pruneForeignNative()
const replaced = materialiseLinks(outDir)
console.log(`dereferenced ${replaced} symlink(s)`)
require('./native-conversation-delegate.cjs').apply(outDir)
require('./native-supercode-compat.cjs').apply(outDir)
verify()

const size = execFileSync('du', ['-sh', outDir], { encoding: 'utf8' }).split('\t')[0]
console.log(`staged tree verified for ${platform}-${arch} (${size.trim()}) on ${os.release()}`)

// Privacy scrub: pnpm's .modules.yaml records absolute paths from the BUILD
// machine (the store under the builder's home directory). The runtime never
// reads it — Node resolution walks node_modules directly — so shipping it
// only ships the builder's username. Scrub the tree THIS run actually staged
// (outDir), not a hardcoded default path — a custom --out would otherwise ship
// the file unscrubbed.
{
  const fs = require('node:fs')
  const path = require('node:path')
  try { fs.rmSync(path.join(outDir, 'node_modules', '.modules.yaml'), { force: true }) } catch {}
  // Shared-lockfile deploy rewrites these with absolute file:// workspace
  // locations. Resolution is complete; don't ship builder paths as metadata.
  fs.rmSync(path.join(outDir, 'pnpm-lock.yaml'), { force: true })
  fs.rmSync(path.join(outDir, 'pnpm-workspace.yaml'), { force: true })
  fs.copyFileSync(path.join(ROOT, 'shell', 'package.json'), path.join(outDir, 'package.json'))
}

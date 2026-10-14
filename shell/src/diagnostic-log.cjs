'use strict'
/** Private, bounded, rolling diagnostics for the desktop shell. */

const fs = require('node:fs')
const path = require('node:path')

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 2 * 1024 * 1024
const SWEEP_MS = 60 * 1000
const MAX_MESSAGE = 1400

function redactDiagnostic (value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[redacted]')
    .replace(/\b((?:set-cookie|cookie)["']?\s*[:=]\s*).*/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+/gi, '$1 [redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[redacted]')
    .slice(0, MAX_MESSAGE)
}

function cleanLabel (value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 64) || 'unknown'
}

/**
 * The file stays readable in TextEdit. Invalid lines, entries outside the last
 * 24 hours, and oldest lines above the size cap are discarded on every sweep.
 * Sweeps run on open and at most once a minute while appending, so a busy host
 * never rereads a multi-megabyte file for every line.
 */
function createDiagnosticLog ({ file, now = Date.now, io = fs, maxBytes = MAX_BYTES } = {}) {
  if (!file || !path.isAbsolute(file)) throw new TypeError('diagnostic log needs an absolute file path')
  let lastSweep = -Infinity

  function ensureFile () {
    io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    if (!io.existsSync(file)) io.writeFileSync(file, '', { encoding: 'utf8', mode: 0o600 })
    io.chmodSync(file, 0o600)
  }

  function prune () {
    try {
      ensureFile()
      const time = now()
      const cutoff = time - DAY_MS
      const lines = io.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      const retained = []
      let bytes = 0
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const stamp = /^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\]/.exec(lines[i])?.[1]
        const age = stamp ? Date.parse(stamp) : NaN
        if (!Number.isFinite(age) || age < cutoff || age > time) continue
        const length = Buffer.byteLength(lines[i] + '\n')
        if (bytes + length > maxBytes) break
        retained.push(lines[i])
        bytes += length
      }
      const body = retained.reverse().join('\n') + (retained.length ? '\n' : '')
      const temp = `${file}.${process.pid}.tmp`
      io.writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
      io.renameSync(temp, file)
      io.chmodSync(file, 0o600)
      lastSweep = time
      return true
    } catch {
      // A broken diagnostics directory must not take down the app.
      return false
    }
  }

  function write (level, source, message) {
    try {
      ensureFile()
      const time = now()
      const entry = `[${new Date(time).toISOString()}] [${cleanLabel(level)}] [${cleanLabel(source)}] ${redactDiagnostic(message)}\n`
      io.appendFileSync(file, entry, { encoding: 'utf8', mode: 0o600 })
      if (time - lastSweep >= SWEEP_MS || io.statSync(file).size > maxBytes) prune()
      return true
    } catch {
      return false
    }
  }

  function revealPath () {
    prune()
    return file
  }

  return { write, prune, revealPath, file }
}

module.exports = { createDiagnosticLog, redactDiagnostic, DAY_MS, MAX_BYTES }

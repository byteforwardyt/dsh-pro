/** Bounded cache of serialized per-session summaries, never event/row arrays. */
export class UsageSummaryCache {
  #entries = new Map()
  #bytes = 0

  constructor ({maxEntries = 256, maxBytes = 8 * 1024 * 1024} = {}) {
    if (![maxEntries, maxBytes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new TypeError('Invalid usage cache budget')
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  get size () { return this.#entries.size }
  get retainedBytes () { return this.#bytes }
  keys () { return this.#entries.keys() }

  get (file) {
    const entry = this.#entries.get(file)
    if (!entry) return undefined
    this.#entries.delete(file)
    this.#entries.set(file, entry)
    return JSON.parse(entry.text)
  }

  delete (file) {
    const entry = this.#entries.get(file)
    if (!entry) return
    this.#bytes -= entry.bytes
    this.#entries.delete(file)
  }

  set (file, value) {
    this.delete(file)
    const text = JSON.stringify(value)
    // Upper bound for UTF-16 string payloads. Map/object overhead is separately
    // constrained by maxEntries; this does not claim to cap the whole JS heap.
    const bytes = 2 * (file.length + text.length)
    if (!this.maxEntries || bytes > this.maxBytes) return
    while (this.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) this.delete(this.keys().next().value)
    this.#entries.set(file, {text, bytes})
    this.#bytes += bytes
  }
}

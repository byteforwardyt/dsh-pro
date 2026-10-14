import { setImmediate } from 'node:timers/promises'

/**
 * Fold one session's events into per-model-call usage rows.
 *
 * A turn's model comes from the `request/header` that opened it, and its tokens
 * from the usage chunks that follow — so the walk carries the most recent
 * header forward. As in the harness token-meter projection, the latest sample
 * for a turn/step replaces earlier chunks; a finalized message can provide the
 * authoritative sample and source. Title requests do not emit these usage rows
 * and must not overwrite the agent request's model identity.
 */
export function createSessionUsage (sessionId) {
  const rows = []
  const steps = new Map()
  let invalidUsage = false
  let provider = null
  let model = null
  let time = null

  const accept = (event) => {
    const type = event?.type
    const data = event?.data
    if (typeof event?.time === 'number' && Number.isFinite(new Date(event.time).getTime())) time = event.time

    if (type === 'request/header') {
      const config = data?.header?.config
      if (config) { provider = config.provider ?? null; model = config.model ?? null }
      return
    }
    const keyed = Number.isSafeInteger(data?.turn) && data.turn >= 0 && Number.isSafeInteger(data?.step) && data.step >= 0
    const usage = type === 'assistant/chunk' && data?.chunk?.type === 'usage' ? data.chunk.usage
      : type === 'assistant/message' && keyed ? data.usage : null
    if (!usage) return
    const input = usage.inputTokens
    const output = usage.outputTokens
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    if (![input, output, cacheRead, cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0)) { invalidUsage = true; return }

    const source = type === 'assistant/message' ? data.message?.source : null
    const identity = value => typeof value === 'string' && value ? value : 'unknown'
    const row = {
      sessionId,
      provider: identity(source?.provider ?? provider),
      model: identity(source?.model ?? model),
      at: time ?? null,
      input,
      output,
      cacheRead,
      cacheWrite,
    }
    if (keyed) {
      const key = `${data.turn}/${data.step}`
      const previous = steps.get(key)
      if (previous !== undefined) rows[previous] = row
      else { steps.set(key, rows.length); rows.push(row) }
    } else rows.push(row) // Preserve legacy chunks without a turn/step identity.
  }
  return { accept, rows, get invalidUsage () { return invalidUsage } }
}

const emptyMetrics = () => ({input:0,output:0,cacheRead:0,cacheWrite:0,total:0,turns:0})
const addMetrics = (target, value) => {
  for (const key of ['input','output','cacheRead','cacheWrite','total','turns']) target[key] += value[key]
}
const earlier = (a,b) => a === null ? b : b === null ? a : Math.min(a,b)
const later = (a,b) => a === null ? b : b === null ? a : Math.max(a,b)

/** Local-time days, recomputed if the cached summary's timezone changes. */
function dayKey (ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}

/** Merge compact session summaries without retaining every call in history. */
export class UsageAccumulator {
  totals = emptyMetrics()
  models = new Map()
  days = new Map()
  hours = new Array(24).fill(0)
  sessions = new Set()
  firstAt = null
  lastAt = null

  addRow (row) {
    const value = {...row,total:row.input+row.output+row.cacheRead+row.cacheWrite,turns:1}
    addMetrics(this.totals,value)
    this.sessions.add(row.sessionId)
    this.addModel(value)
    if (typeof row.at === 'number') {
      this.firstAt = earlier(this.firstAt,row.at)
      this.lastAt = later(this.lastAt,row.at)
      this.addDay({...value,day:dayKey(row.at)})
      this.hours[new Date(row.at).getHours()] += value.total
    }
  }

  addModel (value) {
    const key = JSON.stringify([value.provider,value.model])
    const target = this.models.get(key) ?? {...emptyMetrics(),provider:value.provider,model:value.model}
    addMetrics(target,value)
    this.models.set(key,target)
  }

  addDay (value) {
    const target = this.days.get(value.day) ?? {...emptyMetrics(),day:value.day}
    addMetrics(target,value)
    this.days.set(value.day,target)
  }

  async merge (summary, sessionId, signal) {
    signal?.throwIfAborted()
    addMetrics(this.totals,summary.totals)
    if (summary.totals.turns) this.sessions.add(sessionId)
    this.firstAt = earlier(this.firstAt,summary.totals.firstAt)
    this.lastAt = later(this.lastAt,summary.totals.lastAt)
    let count = 0
    for (const model of summary.models) {
      if (++count % 512 === 0) { await setImmediate(); signal?.throwIfAborted() }
      this.addModel(model)
    }
    for (const day of summary.days) {
      if (++count % 512 === 0) { await setImmediate(); signal?.throwIfAborted() }
      this.addDay(day)
    }
    for (let hour=0;hour<24;hour++) this.hours[hour] += summary.hours[hour]
  }

  summary () {
    return {
      totals:{...this.totals,sessions:this.sessions.size,firstAt:this.firstAt,lastAt:this.lastAt},
      models:[...this.models.values()].sort((a,b)=>b.total-a.total || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
      days:[...this.days.values()].sort((a,b)=>a.day.localeCompare(b.day)),
      hours:this.hours,
    }
  }
}

export async function summarizeRows (rows, signal) {
  const accumulator = new UsageAccumulator()
  let count = 0
  for (const row of rows) {
    if (++count % 512 === 0) await setImmediate()
    signal?.throwIfAborted()
    accumulator.addRow(row)
  }
  return accumulator.summary()
}

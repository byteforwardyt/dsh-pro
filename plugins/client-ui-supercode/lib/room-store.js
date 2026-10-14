import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { ACTIVE, RoomError, check, identifier, stopClock } from './room-state.js'

/** A private append-only journal. Only committed, fsynced events reach observers. */
export class RoomStore extends EventEmitter {
  constructor(directory) {
    super(); this.directory = directory; this.rooms = new Map(); this.errors = []; this.failed = new Set()
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    for (const file of fs.readdirSync(directory).filter(name => /^[a-zA-Z0-9_-]+\.jsonl$/.test(name))) {
      try {
        const full = path.join(directory, file), data = fs.readFileSync(full, 'utf8')
        const end = data.lastIndexOf('\n') + 1
        let room = null
        for (const line of data.slice(0, end).split('\n').filter(Boolean)) {
          const event = JSON.parse(line)
          check(event.version === 1 && event.seq === (room?.revision ?? -1) + 1, 'Unsupported or corrupt SuperCode journal.')
          check(event.id === file.slice(0, -6) && event.patch && typeof event.patch === 'object', 'Invalid room journal identity.')
          room = { ...room, ...event.patch, revision: event.seq }
          check(event.unset === undefined || (Array.isArray(event.unset) && event.unset.every(key => typeof key === 'string' && !['id', 'version', 'revision'].includes(key))), 'Invalid journal removals.')
          for (const key of event.unset || []) delete room[key]
        }
        check(room?.version === 1 && Array.isArray(room.members) && Array.isArray(room.tasks) && Array.isArray(room.messages), 'Incomplete room journal.')
        // Only an incomplete final append is recoverable; malformed committed lines fail closed.
        if (end !== data.length) fs.truncateSync(full, Buffer.byteLength(data.slice(0, end)))
        this.rooms.set(room.id, room)
        if (ACTIVE.has(room.status)) this.change(room.id, null, 'recovered-paused', next => {
          stopClock(next, next.updatedAt); next.status = 'paused'; next.reason = 'The app restarted. Review progress, then Resume.'
          delete next.pendingOutcome
          for (const task of next.tasks) if (task.status === 'working') { task.status = 'blocked'; task.revision++; task.interrupted = true }
          for (const id of Object.keys(next.memberStates)) next.memberStates[id] = 'Waiting'
        })
      } catch {
        this.rooms.delete(file.slice(0, -6))
        this.errors.push(`Could not restore SuperCode room ${file.slice(0, -6)}. Its journal was preserved.`)
      }
    }
  }
  list() { return [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(room => structuredClone(room)) }
  get(id) { identifier(id); const room = this.rooms.get(id); check(room, 'Room not found.', 404); return structuredClone(room) }
  add(room) {
    check(!this.rooms.has(room.id), 'Room already exists.', 409)
    this.commit(null, room, 'created'); return this.get(room.id)
  }
  change(id, revision, kind, update) {
    const before = this.get(id)
    if (revision !== null && revision !== undefined) check(before.revision === revision, 'Room changed. Refresh before trying again.', 409)
    const next = structuredClone(before), result = update(next)
    next.revision++; next.updatedAt = Date.now()
    this.commit(before, next, kind)
    return { room: this.get(id), result: result === undefined ? undefined : structuredClone(result) }
  }
  commit(before, room, kind) {
    check(!this.failed.has(room.id), 'Journal write failed. Restart the app before resuming this room.', 503)
    const patch = Object.fromEntries(Object.entries(room).filter(([key, value]) => !before || JSON.stringify(value) !== JSON.stringify(before[key])))
    const unset = before ? Object.keys(before).filter(key => !Object.hasOwn(room, key)) : []
    const event = { version: 1, id: room.id, seq: room.revision, kind, at: room.updatedAt, patch, ...(unset.length ? { unset } : {}) }
    const data = Buffer.from(JSON.stringify(event) + '\n'), target = path.join(this.directory, identifier(room.id) + '.jsonl')
    let fd
    try {
      fd = fs.openSync(target, before ? 'a' : 'ax', 0o600)
      let offset = 0
      while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset)
      fs.fsyncSync(fd)
    } catch {
      this.failed.add(room.id)
      this.emit('fault', room.id)
      throw new RoomError('Could not save SuperCode progress. Work has been stopped; the journal is preserved.', 503)
    } finally { if (fd !== undefined) fs.closeSync(fd) }
    this.rooms.set(room.id, room)
    this.emit('change', structuredClone(room))
  }
}

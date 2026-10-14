/** Stream attachments into a workspace, with unique names and no overwrite. */
import { mkdir, realpath, open, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { workspaceRoots } from './roots.js'
import { contentTypeFor } from './mime.js'
export const UPLOAD_LIMIT = 100 * 1024 * 1024
const fail = (message, status) => Object.assign(new Error(message), { status })
export function createUploads(ctx) {
  let active = 0
  async function receive(req, rawRoot, rawName) {
    if (active >= 3) throw fail('Three uploads are already running. Try again shortly.', 429)
    if (req.headers['content-type'] !== 'application/octet-stream') throw fail('Send file bytes as application/octet-stream.', 415)
    if (Number(req.headers['content-length']) > UPLOAD_LIMIT) throw fail('Files must be 100 MB or smaller.', 413)
    if (typeof rawRoot !== 'string' || rawRoot.includes('\0')) throw fail('Choose an opened workspace.', 403)
    const root = await realpath(rawRoot).catch(() => null)
    const roots = await Promise.all(workspaceRoots(ctx).map(p => realpath(p).catch(() => null)))
    if (!root || !roots.includes(root)) throw fail('Choose an opened workspace.', 403)
    if (typeof rawName !== 'string' || !rawName.trim() || Buffer.byteLength(rawName) > 240 || /[\0-\x1f\x7f/\\]/.test(rawName)) throw fail('Invalid file name.', 400)
    // Root validation awaits I/O, so recheck admission after it settles.
    if (active >= 3) throw fail('Three uploads are already running. Try again shortly.', 429)
    active++
    let file, path
    try {
      const folder = join(root, '.dsh-attachments')
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const actual = await realpath(folder)
      if (actual !== folder || !actual.startsWith(root + sep)) throw fail('The attachment folder must be inside this workspace and cannot be a link.', 403)
      // A unique subdirectory preserves the original filename and its extension.
      const dir = join(actual, randomUUID()); await mkdir(dir, { mode: 0o700 })
      path = join(dir, rawName)
      file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      let size = 0
      req.setTimeout?.(60000, () => req.destroy())
      for await (const chunk of req) {
        size += chunk.length
        if (size > UPLOAD_LIMIT) throw fail('Files must be 100 MB or smaller.', 413)
        await file.writeFile(chunk)
      }
      await file.close(); file = null
      return { path, name: rawName, size, type: contentTypeFor(rawName) }
    } catch (error) {
      await file?.close().catch(() => {})
      if (path) await unlink(path).catch(() => {})
      throw error
    } finally { active-- }
  }
  return { receive }
}

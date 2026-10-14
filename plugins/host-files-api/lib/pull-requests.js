/** Read local Git state and GitHub PRs for an opened workspace. Never run hooks. */
import { execFile } from 'node:child_process'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { promisify } from 'node:util'
import { isAbsolute, resolve } from 'node:path'
import { containedPath, workspaceRoots } from './roots.js'

const execute = promisify(execFile)
const FIELDS = 'number,title,url,author,isDraft,updatedAt,headRefName,baseRefName'

export async function executable (name) {
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const candidate = `${directory}/${name}`
    try { await access(candidate, constants.X_OK); return candidate } catch {}
  }
  return name
}

/** Accept GitHub HTTPS/SSH URLs without ever returning credentials to the client. */
function githubRepository (remote) {
  const scp = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(remote)
  if (scp) return scp[1]
  try {
    const url = new URL(remote)
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return null
    if (url.port && url.port !== (url.protocol === 'ssh:' ? '22' : '443')) return null
    return /^\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname)?.[1] || null
  } catch { return null }
}

/** Porcelain v2 uses NUL records so spaces/newlines and rename sources stay intact. */
export function gitSnapshot (stdout) {
  const result = { branch: null, detached: false, unborn: false, upstream: null, ahead: null, behind: null,
    changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    if (record.startsWith('# branch.head ')) {
      const name = record.slice(14)
      result.detached = name === '(detached)'
      result.branch = result.detached ? null : name.slice(0, 200)
    } else if (record.startsWith('# branch.oid ')) result.unborn = record.slice(13) === '(initial)'
    else if (record.startsWith('# branch.upstream ')) result.upstream = record.slice(18, 218)
    else if (record.startsWith('# branch.ab ')) {
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      if (counts) { result.ahead = Number(counts[1]); result.behind = Number(counts[2]) }
    } else if (/^[12u?] /.test(record)) {
      result.changed++
      if (record[0] === '?') result.untracked++
      else if (record[0] === 'u') result.conflicts++
      else {
        const status = record.split(' ', 2)[1]
        if (status[0] !== '.') result.staged++
        if (status[1] !== '.') result.unstaged++
        if (record[0] === '2') i++ // next NUL record is the original name
      }
    }
  }
  if (!result.branch && !result.detached) throw new Error('Invalid Git status response')
  return result
}

export function createPullRequests (ctx, run = execute, ghPath = () => executable('gh'), gitPath = () => executable('git')) {
  const pending = new Map()
  async function list (root, state = 'open') {
    if (!['open', 'closed', 'merged'].includes(state)) throw Object.assign(new Error('Invalid pull request state.'), { status: 400 })
    // Report a moved/unreadable SAVED folder before canonical containment. This
    // distinction is only exposed for an exact registered path, never arbitrary
    // client paths, so it does not create a filesystem existence oracle.
    if (typeof root === 'string' && !root.includes('\0') && isAbsolute(root)
      && workspaceRoots(ctx).some(path => resolve(path) === resolve(root))) {
      try { await realpath(root) } catch (error) {
        return { repository: null, git: null, items: [], issue: 'workspace-unavailable',
          unavailable: error.code === 'ENOENT' || error.code === 'ENOTDIR'
            ? 'This workspace folder was moved or removed. Open its current location in Workspaces, then choose it here.'
            : 'This workspace folder cannot be accessed. Check its permissions or reopen it in Workspaces, then refresh.' }
      }
    }
    const contained = await containedPath(ctx, root)
    // A separately opened nested workspace is valid even when containment first
    // matches its parent. Arbitrary subdirectories are still refused.
    const opened = contained && await Promise.all(workspaceRoots(ctx).map(path => realpath(path).catch(() => null)))
    if (!contained || !opened.includes(contained.path)) throw Object.assign(new Error('Choose an opened workspace.'), { status: 403 })
    const key = contained.path + ':' + state
    if (pending.has(key)) return pending.get(key)
    const task = (async () => {
      const options = { cwd: contained.path, timeout: 15000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }
      let git, gitCommand
      try {
        gitCommand = await gitPath()
        const result = await run(gitCommand, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
          'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=none'], options)
        git = gitSnapshot(result.stdout)
      } catch (error) {
        const details = String(error.stderr || '')
        const issue = error.code === 'ENOENT' ? 'git-missing' : /not a git repository/i.test(details) ? 'not-repository' : 'git-unavailable'
        const unavailable = issue === 'git-missing' ? 'Git is not installed or cannot be found. Install Git, then refresh.'
          : issue === 'not-repository' ? 'This folder is not a Git repository. Choose an existing repository in Workspaces.'
            : /dubious ownership/i.test(details) ? 'Git refused this repository because its ownership differs. Check its ownership in Terminal, then refresh.'
              : error.killed ? 'Reading Git status timed out. Try refreshing.'
                : 'Git status could not be read. Check that the workspace still exists and Git can read it, then refresh.'
        return { repository: null, git: null, items: [], issue, unavailable }
      }
      let repository, remoteName
      try {
        const { stdout } = await run(gitCommand, ['config', '--get-regexp', '^remote\\..*\\.url$'], options)
        const remotes = stdout.split('\n').flatMap(line => {
          const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line)
          const repo = match && githubRepository(match[2].trim())
          return repo ? [{ name: match[1], repository: repo }] : []
        })
        const remote = remotes.find(item => item.name === 'origin') || remotes.find(item => item.name === 'upstream') || remotes[0]
        repository = remote?.repository; remoteName = remote?.name
      } catch (error) {
        // git config exits 1 when no remote URL exists. Other failures are not
        // an empty repository or a missing remote.
        if (error.code !== 1) return { repository: null, git, items: [], issue: 'remote-unavailable', unavailable: 'Git remote configuration could not be read. Check repository access, then refresh.' }
      }
      if (!repository) return { repository: null, git, items: [], issue: 'no-github-remote',
        unavailable: 'Local Git is available. Add a GitHub remote to this repository to see pull requests here.' }
      try {
        const { stdout } = await run(await ghPath(), ['pr', 'list', '--repo', `github.com/${repository}`, '--state', state, '--limit', '50', '--json', FIELDS], options)
        const rows = JSON.parse(stdout)
        if (!Array.isArray(rows) || rows.length > 50) throw new Error('invalid-response')
        const items = rows.map(row => {
          const expected = `https://github.com/${repository}/pull/${row.number}`
          if (!Number.isSafeInteger(row.number) || row.number < 1 || typeof row.url !== 'string' || row.url.toLowerCase() !== expected.toLowerCase() || typeof row.title !== 'string') throw new Error('invalid-response')
          return { number: row.number, title: row.title.slice(0, 1000), url: row.url,
            author: typeof row.author?.login === 'string' ? row.author.login : '', isDraft: row.isDraft === true,
            updatedAt: row.updatedAt, head: String(row.headRefName || '').slice(0, 200), base: String(row.baseRefName || '').slice(0, 200) }
        })
        return { repository, remoteName, git, items, limit: 50 }
      } catch (error) {
        const details = String(error.stderr || '')
        const issue = error.code === 'ENOENT' ? 'gh-missing' : /auth login|not logged|authentication|HTTP 401/i.test(details) ? 'gh-auth' : 'gh-unavailable'
        const unavailable = issue === 'gh-missing' ? 'Install GitHub CLI, then sign in with gh auth login.'
          : issue === 'gh-auth' ? 'Sign in to GitHub CLI with gh auth login, then refresh.'
            : error.killed ? 'GitHub took too long to respond. Try refreshing.'
              : 'Could not load pull requests. Check GitHub CLI access to this repository and try again.'
        return { repository, remoteName, git, items: [], issue, unavailable }
      }
    })()
    pending.set(key, task)
    try { return await task } finally { pending.delete(key) }
  }
  return { list }
}

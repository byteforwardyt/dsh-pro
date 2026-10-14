/** Explicit, revision-checked Git actions for an opened repository. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { workspaceRoots } from './roots.js'
import { executable, gitSnapshot } from './pull-requests.js'

const execute = promisify(execFile)
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
export function createGit(ctx, run = execute) {
  const active = new Set()
  async function openedWorkspace(raw) {
    if (typeof raw !== 'string' || raw.includes('\0')) throw fail('Choose an opened workspace.', 403)
    const opened = await Promise.all(workspaceRoots(ctx).map(p => realpath(p).catch(() => null)))
    const root = await realpath(raw).catch(() => null)
    if (!root || !opened.includes(root)) throw Object.assign(fail('Reopen this workspace folder to use Git.', 403), {code:'WORKSPACE_NOT_OPEN'})
    return root
  }
  function gitRunner (root) {
    return async (...args) => {
      const binary = await executable('git')
      try {
        return (await run(binary, ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
          cwd: root, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
        })).stdout
      } catch (error) {
        const stderr = String(error.stderr || '')
        if (/not a git repository/.test(stderr)) throw Object.assign(fail('This workspace is not a Git repository.', 422), {code:'NOT_A_GIT_REPOSITORY'})
        if (/overwritten|local changes/.test(stderr)) throw fail('Save or commit your changes before switching branches.', 409)
        if (/identity|user.email|user.name/.test(stderr)) throw fail('Set your Git name and email in Terminal, then retry.', 422)
        if (/non-fast-forward|fetch first|rejected/.test(stderr)) throw fail('Push refused. Fetch and review remote changes before trying again.', 409)
        if (/auth|Permission denied|could not read Username/.test(stderr)) throw fail('Git authentication failed. Sign in to this remote in Terminal, then retry.', 422)
        throw fail(error.killed ? 'Git timed out. Refresh to check the outcome before retrying.' : 'Git could not complete this action. Check repository access and refresh before retrying.', 422)
      }
    }
  }
  async function repository(raw) {
    const root = await openedWorkspace(raw)
    const git = gitRunner(root)
    const top = (await git('rev-parse', '--show-toplevel')).trim()
    // Never change a parent repository through an opened nested folder.
    if (await realpath(top) !== root) throw fail('Open the repository root to use Git actions.', 403)
    return { root, git }
  }
  async function snapshot({ git }) {
    const status = await git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all')
    const state = gitSnapshot(status)
    const files = [], records = status.split('\0')
    for (let i = 0; i < records.length; i++) {
      const row = records[i], kind = row[0]
      if (!['1', '2', 'u', '?'].includes(kind)) continue
      const fields = kind === '?' ? 1 : kind === '1' ? 8 : kind === '2' ? 9 : 10
      let offset = 0
      for (let n = 0; n < fields; n++) offset = row.indexOf(' ', offset) + 1
      const name = row.slice(offset), xy = row.slice(2, 4)
      files.push({ path: name, staged: kind !== '?' && xy[0] !== '.', unstaged: kind === '?' || xy[1] !== '.', conflict: kind === 'u', untracked: kind === '?' })
      if (kind === '2') files.at(-1).original = records[++i]
    }
    const stagedDiff = await git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--')
    const workingDiff = await git('diff', '--no-ext-diff', '--no-textconv', '--binary', '--')
    const head = state.unborn ? '' : (await git('rev-parse', 'HEAD')).trim()
    const branches = (await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/')).trim().split('\n').filter(Boolean)
    let push = null, pushIdentity = '', pushWarning = ''
    if (state.branch && state.upstream) {
      const remote = (await git('config', '--get', `branch.${state.branch}.remote`)).trim()
      const target = (await git('config', '--get', `branch.${state.branch}.merge`)).trim()
      if (remote && remote !== '.' && !remote.startsWith('-') && /^refs\/heads\//.test(target)) {
        const urls = (await git('remote', 'get-url', '--push', '--all', remote)).trim().split('\n')
        const url = urls[0]
        // Avoid exposing embedded credentials in the review panel.
        const destination = url.replace(/(https?:\/\/)[^/@]+@/g, '$1').replace(/[?#].*$/, '')
        if (urls.length === 1) {
          push = { remote, target, destination }
          pushIdentity = createHash('sha256').update(url).digest('hex')
        } else pushWarning = 'This remote has multiple push destinations. Use Terminal to review and push.'
      }
    }
    const revision = createHash('sha256').update(JSON.stringify({ status, head, stagedDiff, workingDiff, push, pushIdentity })).digest('hex')
    return { ...state, files, head, branches, push, pushWarning, revision, stagedDiff, workingDiff }
  }
  async function read(root) { return snapshot(await repository(root)) }
  async function change(body) {
    if (!body || !['stage', 'unstage', 'commit', 'push', 'switch', 'init'].includes(body.action)) throw fail('Unknown Git action.')
    if (body.action === 'init') {
      const root = await openedWorkspace(body.root)
      if (active.has(root)) throw fail('Another Git action is running. Refresh when it finishes.', 409)
      active.add(root)
      try {
        const git = gitRunner(root)
        let top = null
        try {
          top = (await git('rev-parse', '--show-toplevel')).trim()
        } catch (error) {
          if (error.code !== 'NOT_A_GIT_REPOSITORY') throw error
        }
        if (top) {
          if (await realpath(top) === root) throw fail('This workspace is already a Git repository.', 409)
          throw fail('Open the repository root to use Git actions.', 403)
        }
        await git('init', '-b', 'main')
        return snapshot({ git, root })
      } finally { active.delete(root) }
    }
    const repo = await repository(body.root)
    if (active.has(repo.root)) throw fail('Another Git action is running. Refresh when it finishes.', 409)
    active.add(repo.root)
    try {
      const current = await snapshot(repo)
      if (body.revision !== current.revision) throw fail('The repository changed. Refresh and review it again.', 409)
      const { git } = repo
      if (body.action === 'stage' || body.action === 'unstage') {
        const file = current.files.find(f => f.path === body.path)
        if (!file || file.conflict) throw fail('Choose a changed file without unresolved conflicts.')
        // Literal pathspec prevents a filename being interpreted as Git magic.
        const paths = [file.path, ...(file.original ? [file.original] : [])].map(p => `:(literal)${p}`)
        if (body.action === 'stage') await git('add', '--', ...paths)
        else if (current.unborn) await git('rm', '--cached', '--', ...paths)
        else await git('restore', '--staged', '--', ...paths)
      } else if (body.action === 'commit') {
        if (!current.staged || current.conflicts) throw fail('Stage changes and resolve conflicts before committing.')
        if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000 || body.message.includes('\0')) throw fail('Enter a commit message of 1–4000 characters.')
        // Normal hooks/signing remain enabled; only staged changes are committed.
        await git('commit', '-m', body.message.trim())
      } else if (body.action === 'switch') {
        if (!current.branches.includes(body.branch) || body.branch.startsWith('-')) throw fail('Choose an existing local branch.')
        await git('switch', '--no-guess', body.branch)
      } else {
        if (!current.push || current.detached || current.unborn) throw fail('Configure a tracking branch in Terminal before pushing.')
        if (body.confirm !== current.head) throw fail('Review the current commit and confirm the push.')
        // Explicit local refspec, never force, and never push all branches/tags.
        await git('-c', `remote.${current.push.remote}.mirror=false`, 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', current.push.remote, `${current.head}:${current.push.target}`)
      }
      return await snapshot(repo)
    } finally { active.delete(repo.root) }
  }
  return { read, change }
}

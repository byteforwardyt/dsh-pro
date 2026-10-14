import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createPullRequests } from '../lib/pull-requests.js'

async function fixture(t, run) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'dsh-prs-')))
  const root = join(parent, 'workspace'), outside = join(parent, 'outside')
  await mkdir(root); await mkdir(outside)
  t.after(() => rm(parent, { recursive: true, force: true }))
  const ctx = { workspaceRegistry: { list: () => [{ path: root }] } }
  return { root, outside, ctx, api: createPullRequests(ctx, run && (async (command, args, options) => args.includes('--porcelain=v2') ? { stdout: '# branch.oid abc\0# branch.head main\0' } : run(command, args, options)), async () => '/usr/bin/gh', async () => 'git') }
}
const row = { number: 42, title: 'A useful change', url: 'https://github.com/example/project/pull/42', author: { login: 'author' }, headRefName: 'feature', baseRefName: 'main' }

test('PR reader fences workspaces and invokes only bounded read-only commands', async t => {
  const calls = []
  const f = await fixture(t, async (command, args, options) => { calls.push({ command, args, options }); return { stdout: command === 'git' ? 'remote.origin.url git@github.com:example/project.git\n' : JSON.stringify([row]) } })
  const result = await f.api.list(f.root, 'merged')
  assert.equal(result.repository, 'example/project'); assert.equal(result.items[0].number, 42)
  assert.deepEqual(calls[0].args, ['config', '--get-regexp', '^remote\\..*\\.url$'])
  assert.equal(calls[1].args.includes('merged'), true); assert.equal(calls[1].args.includes('50'), true)
  assert.equal(calls[1].options.cwd, f.root); assert.equal(calls[1].options.timeout, 15000)
  const before = calls.length
  await assert.rejects(f.api.list(f.outside), { status: 403 })
  await assert.rejects(f.api.list(f.root, 'delete'), { status: 400 })
  await symlink(f.outside, join(f.root, 'escape'))
  await assert.rejects(f.api.list(join(f.root, 'escape')), { status: 403 })
  assert.equal(calls.length, before)
})
test('PR reader provides useful authentication and remote errors without leaking CLI stderr', async t => {
  const f = await fixture(t, async command => {
    if (command === 'git') return { stdout: 'remote.origin.url https://github.com/example/project.git' }
    throw Object.assign(new Error('private token'), { stderr: 'Run gh auth login (private token)' })
  })
  const result = await f.api.list(f.root)
  assert.match(result.unavailable, /gh auth login/); assert.doesNotMatch(JSON.stringify(result), /private token/)
  const other = await fixture(t, async () => ({ stdout: 'https://untrusted.example/project.git' }))
  assert.match((await other.api.list(other.root)).unavailable, /GitHub remote/)
})
test('PR reader refuses executable or mismatched links from a CLI response', async t => {
  const f = await fixture(t, async command => ({ stdout: command === 'git' ? 'remote.origin.url git@github.com:example/project.git' : JSON.stringify([{ ...row, url: 'javascript:alert(1)' }]) }))
  const result = await f.api.list(f.root)
  assert.equal(result.items.length, 0); assert.ok(result.unavailable)
})

const execute = promisify(execFile)
async function repository(t) {
  const f = await fixture(t)
  const git = (...args) => execute('/usr/bin/git', args, { cwd: f.root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } })
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test fixture'); await git('config', 'user.email', 'fixture@example.test')
  await writeFile(join(f.root, 'tracked.txt'), 'base\n')
  await git('add', '.'); await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
  return { ...f, git, api: createPullRequests(f.ctx, execute, async () => '/no-fixture-gh') }
}

test('real Git detects clean, staged, unstaged, untracked, and detached worktree state', async t => {
  const f = await repository(t)
  let result = await f.api.list(f.root)
  assert.equal(result.issue, 'no-github-remote'); assert.equal(result.git.branch, 'main'); assert.equal(result.git.changed, 0)
  assert.equal(result.git.ahead, null, 'without an upstream, ahead is unknown rather than zero')
  await writeFile(join(f.root, 'tracked.txt'), 'staged\n'); await f.git('add', 'tracked.txt')
  await writeFile(join(f.root, 'tracked.txt'), 'unstaged\n'); await writeFile(join(f.root, 'space and\nnewline.txt'), 'new\n')
  result = await f.api.list(f.root)
  assert.deepEqual([result.git.changed, result.git.staged, result.git.unstaged, result.git.untracked], [2, 1, 1, 1])
  await f.git('checkout', '--detach')
  assert.equal((await f.api.list(f.root)).git.detached, true)
  const worktree = join(f.outside, 'linked')
  await f.git('worktree', 'add', '-b', 'linked', worktree)
  f.ctx.workspaceRegistry.list = () => [{ path: f.root }, { path: worktree }]
  assert.equal((await f.api.list(worktree)).git.branch, 'linked')
})

test('real Git parses renames and merge conflicts without mistaking source names for files', async t => {
  const f = await repository(t)
  await f.git('mv', 'tracked.txt', 'renamed with spaces.txt')
  let result = await f.api.list(f.root)
  assert.equal(result.git.changed, 1); assert.equal(result.git.staged, 1)
  await f.git('-c', 'commit.gpgsign=false', 'commit', '-am', 'rename')
  await f.git('checkout', '-b', 'feature'); await writeFile(join(f.root, 'renamed with spaces.txt'), 'feature\n')
  await f.git('-c', 'commit.gpgsign=false', 'commit', '-am', 'feature')
  await f.git('checkout', 'main'); await writeFile(join(f.root, 'renamed with spaces.txt'), 'main\n')
  await f.git('-c', 'commit.gpgsign=false', 'commit', '-am', 'main')
  await assert.rejects(f.git('merge', 'feature'))
  result = await f.api.list(f.root)
  assert.equal(result.git.conflicts, 1); assert.equal(result.git.changed, 1)
})

test('GitHub upstream remote works and CLI errors retain real local status', async t => {
  const f = await repository(t)
  await f.git('remote', 'add', 'upstream', 'https://github.com/example/project.git')
  let called
  const api = createPullRequests(f.ctx, async (command, args, options) => {
    if (command === 'fixture-gh') { called = args; return { stdout: JSON.stringify([row]) } }
    return execute(command, args, options)
  }, async () => 'fixture-gh')
  const result = await api.list(f.root, 'closed')
  assert.equal(result.repository, 'example/project'); assert.equal(result.remoteName, 'upstream'); assert.equal(result.items[0].number, 42)
  assert.ok(called.includes('closed')); assert.ok(called.includes('github.com/example/project'))
  const missing = await f.api.list(f.root)
  assert.equal(missing.issue, 'gh-missing'); assert.equal(missing.git.branch, 'main')
})

test('non-repository, unavailable Git, unborn branch, and opened nested roots are distinguished', async t => {
  const f = await fixture(t)
  assert.equal((await f.api.list(f.root)).issue, 'not-repository')
  const absent = createPullRequests(f.ctx, execute, undefined, async () => '/no-fixture-git')
  assert.equal((await absent.list(f.root)).issue, 'git-missing')
  await execute('/usr/bin/git', ['init', '-b', 'new'], { cwd: f.root })
  assert.equal((await f.api.list(f.root)).git.unborn, true)
  const nested = join(f.root, 'nested'); await mkdir(nested)
  await assert.rejects(f.api.list(nested), { status: 403 })
  f.ctx.workspaceRegistry.list = () => [{ path: f.root }, { path: nested }]
  assert.equal((await f.api.list(nested)).git.branch, 'new')
})

test('Git status disables fsmonitor execution and no optional lock is requested', async t => {
  const f = await fixture(t)
  const api = createPullRequests(f.ctx, async (command, args, options) => {
    assert.equal(command, 'fixture-git')
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
    if (args.includes('status')) {
      assert.ok(args.includes('core.fsmonitor=false')); assert.ok(args.includes('--ignore-submodules=none'))
      return { stdout: '# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0' }
    }
    throw Object.assign(new Error('no remote'), { code: 1 })
  }, undefined, async () => 'fixture-git')
  const result = await api.list(f.root)
  assert.equal(result.git.ahead, 2); assert.equal(result.git.behind, 3); assert.equal(result.git.upstream, 'origin/main')
})

test('canonical GitHub URL casing is accepted but other repositories are refused', async t => {
  const f = await fixture(t, async command => ({ stdout: command === 'git'
    ? 'remote.origin.url https://github.com/Example/Project.git'
    : JSON.stringify([row]) }))
  const result = await f.api.list(f.root)
  assert.equal(result.items[0].url, row.url)
  const other = await fixture(t, async command => ({ stdout: command === 'git'
    ? 'remote.origin.url https://github.com/example/project.git'
    : JSON.stringify([{ ...row, url: 'https://github.com/other/project/pull/42' }]) }))
  assert.equal((await other.api.list(other.root)).issue, 'gh-unavailable')
})

test('missing saved workspace folders get recovery guidance without exposing arbitrary paths', async t => {
  const f = await fixture(t)
  const missing = join(f.root, 'moved-folder')
  f.ctx.workspaceRegistry.list = () => [{ path: f.root }, { path: missing }]
  const result = await f.api.list(missing)
  assert.equal(result.issue, 'workspace-unavailable')
  assert.match(result.unavailable, /moved or removed/)
  await assert.rejects(f.api.list(join(f.outside, 'missing')), { status: 403 })
  await assert.rejects(f.api.list(join(f.root, 'not-registered')), { status: 403 })
})

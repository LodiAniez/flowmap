import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveDefaultBranch, remoteDefaultBranch, isRemoteUrl } from '../lib/branch.js'

const run = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const root = mkdtempSync(join(tmpdir(), 'flowmap-branch-'))

// Deliberately NOT main or master: a default branch name is data, never a convention to
// hardcode. If detection ever regresses to a guess, "trunk" is what catches it.
const upstream = join(root, 'upstream')
mkdirSync(upstream)
run(['init', '-q', '-b', 'trunk'], upstream)
writeFileSync(join(upstream, 'a.txt'), 'hello\n')
run(['add', '-A'], upstream)
run(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], upstream)

const clone = join(root, 'clone')
run(['clone', '-q', upstream, clone], root)

test('reads the default branch from a remote', () => {
  assert.equal(remoteDefaultBranch(upstream), 'trunk')
})

test('a clone reports its upstream default, not a hardcoded guess', () => {
  assert.equal(resolveDefaultBranch(clone).branch, 'trunk')
})

// The regression this guards: a non-bare repo's HEAD is whatever YOU have checked out, so
// asking it directly records a feature branch as the repo's default, permanently.
test('checking out a feature branch does not change the detected default', () => {
  run(['checkout', '-q', '-b', 'feature/wip'], clone)
  assert.equal(run(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim(), 'feature/wip')

  const res = resolveDefaultBranch(clone)
  assert.equal(res.branch, 'trunk', 'must not report the checked-out feature branch')
  assert.equal(res.how, 'remote')
})

test('a repo with no origin reports its checkout, and says so', () => {
  const orphan = join(root, 'orphan')
  mkdirSync(orphan)
  run(['init', '-q', '-b', 'solo'], orphan)
  writeFileSync(join(orphan, 'a.txt'), 'x\n')
  run(['add', '-A'], orphan)
  run(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], orphan)

  const res = resolveDefaultBranch(orphan)
  assert.equal(res.branch, 'solo')
  // The weak provenance is the point: the caller warns on exactly this value.
  assert.equal(res.how, 'local-head')
})

test('branch names containing slashes survive parsing', () => {
  const slashy = join(root, 'slashy')
  mkdirSync(slashy)
  run(['init', '-q', '-b', 'release/2.0'], slashy)
  writeFileSync(join(slashy, 'a.txt'), 'x\n')
  run(['add', '-A'], slashy)
  run(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], slashy)

  assert.equal(remoteDefaultBranch(slashy), 'release/2.0')
})

test('classifies remote urls versus local paths', () => {
  assert.ok(isRemoteUrl('git@github.com:org/repo.git'))
  assert.ok(isRemoteUrl('https://github.com/org/repo.git'))
  assert.ok(!isRemoteUrl('/Users/me/code/repo'))
  assert.ok(!isRemoteUrl('~/code/repo'))
})

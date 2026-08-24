import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, list, BOOLEAN_FLAGS } from '../lib/args.js'

test('parses the three flag spellings and positionals', () => {
  const { flags, positional } = parseArgs(['draft', 'journey', 'checkout', '--seed=a', '--max', '20'])
  assert.deepEqual(positional, ['draft', 'journey', 'checkout'])
  assert.equal(flags.seed, 'a')
  assert.equal(flags.max, '20')
})

test('a repeated flag collapses into an array', () => {
  assert.deepEqual(parseArgs(['--seed', 'a', '--seed', 'b']).flags.seed, ['a', 'b'])
  assert.deepEqual(list(parseArgs(['--repos', 'a,b', '--repos', 'c']).flags.repos), ['a', 'b', 'c'])
})

// The regression: without a boolean whitelist, `--local` binds the next token as its value,
// so the flag reads false AND the positional disappears. A command the user believes is
// doubly scoped then runs against every registered repo.
test('a boolean flag does not swallow the token after it', () => {
  const { flags, positional } = parseArgs(['verify', '--local', 'checkout'])
  assert.equal(flags.local, true)
  assert.deepEqual(positional, ['verify', 'checkout'])
})

test('every boolean flag behaves that way, not just --local', () => {
  for (const flag of ['all', 'force', 'refresh', 'local', 'keep-draft', 'mermaid', 'discover']) {
    const { flags, positional } = parseArgs(['cmd', `--${flag}`, 'target'])
    assert.equal(flags[flag], true, `--${flag} should be boolean`)
    assert.deepEqual(positional, ['cmd', 'target'], `--${flag} must not eat "target"`)
  }
})

test('value-taking flags still consume their value', () => {
  const { flags, positional } = parseArgs(['show', '--out', 'x.md', 'checkout'])
  assert.equal(flags.out, 'x.md')
  assert.deepEqual(positional, ['show', 'checkout'])
})

test('a boolean flag at the end of argv is still true', () => {
  assert.equal(parseArgs(['verify', '--local']).flags.local, true)
})

test('the boolean set covers the flags the CLI actually treats as boolean', () => {
  for (const f of ['all', 'local', 'force', 'no-sync', 'keep-path', 'agent']) {
    assert.ok(BOOLEAN_FLAGS.has(f), `${f} must be declared boolean`)
  }
})

// Every consumer tests `flags.x === true`, so collapsing a repeated boolean into an array
// makes the flag read as false — the flag repeated is the flag ignored, which is the worst
// possible reading of a user typing it twice.
test('a repeated boolean flag stays true', () => {
  for (const flag of ['force', 'all', 'agent', 'local']) {
    const { flags } = parseArgs(['cmd', `--${flag}`, `--${flag}`])
    assert.equal(flags[flag], true, `--${flag} twice must still be true`)
  }
})

test('a repeated value flag still collects', () => {
  assert.deepEqual(list(parseArgs(['--seed', 'a', '--seed', 'b']).flags.seed), ['a', 'b'])
})

import { describe, expect, it } from 'vitest'
import { arePathsEquivalent } from 'common/filesystem/paths'

// The watcher's self-write suppression matches saved paths against watcher
// event paths; on Windows these can differ in casing (drive letter, user
// casing), which must still match (FR-17).
describe('arePathsEquivalent', () => {
  it('matches identical paths', () => {
    expect(arePathsEquivalent('a/b/c.md', 'a/b/c.md')).toBe(true)
  })

  it('matches paths that only differ after normalization', () => {
    expect(arePathsEquivalent('a/b/../b/c.md', 'a/b/c.md')).toBe(true)
  })

  it('matches case-insensitively when requested', () => {
    expect(arePathsEquivalent('C:/Docs/A.MD', 'c:/docs/a.md', true)).toBe(true)
  })

  it('rejects different casing when case-sensitive', () => {
    expect(arePathsEquivalent('a/B.md', 'a/b.md', false)).toBe(false)
  })

  it('rejects different files regardless of mode', () => {
    expect(arePathsEquivalent('a/b.md', 'a/c.md', true)).toBe(false)
  })

  it('rejects empty input', () => {
    expect(arePathsEquivalent('', 'a/b.md')).toBe(false)
  })
})

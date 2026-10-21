import { describe, expect, it } from 'vitest'
import { cleanBody, templateLines } from '../src/clean.js'
import { detectDisclosure } from '../src/disclosure.js'
import { runHeuristics } from '../src/heuristics.js'
import { fixture } from './helpers.js'

const fired = (text: string, words: number, changed: number): string[] =>
  runHeuristics(text, words, { additions: changed, deletions: 0, changedFiles: 1 })
    .signals.filter((s) => s.fired)
    .map((s) => s.id)

describe('runHeuristics', () => {
  it('flags an AI-styled description for a tiny change', () => {
    const clean = cleanBody(fixture('ai.md'))
    const report = runHeuristics(clean.full, clean.totalWords, {
      additions: 2,
      deletions: 1,
      changedFiles: 1
    })
    const ids = report.signals.filter((s) => s.fired).map((s) => s.id)
    expect(ids).toEqual([
      'verbose-for-diff',
      'heavy-structure',
      'restates-diff',
      'stock-phrasing',
      'typography'
    ])
    expect(report.score).toBe(1)
    expect(report.signals[0]!.detail).toBe(
      `${clean.totalWords}-word description for a 3-line change`
    )
  })

  it('stays quiet on a plain human description', () => {
    const clean = cleanBody(fixture('human.md'), {
      templateLines: templateLines(fixture('pull_request_template.md'))
    })
    const report = runHeuristics(clean.full, clean.totalWords, {
      additions: 1,
      deletions: 1,
      changedFiles: 1
    })
    expect(report.signals.filter((s) => s.fired)).toEqual([])
    expect(report.score).toBe(0)
  })

  it('only counts a long description as verbose when the diff is small', () => {
    const words = Array.from({ length: 200 }, () => 'word').join(' ')
    expect(fired(words, 200, 5)).toContain('verbose-for-diff')
    expect(fired(words, 200, 50)).not.toContain('verbose-for-diff')
  })

  it('weights medium signals double', () => {
    const words = Array.from({ length: 200 }, () => 'word').join(' ')
    const report = runHeuristics(words, 200, { additions: 5, deletions: 0, changedFiles: 1 })
    expect(report.score).toBe(Math.round((2 / 7) * 100) / 100)
  })
})

describe('detectDisclosure', () => {
  it('finds tool footers, AI co-author trailers and AI-use statements', () => {
    expect(detectDisclosure(fixture('ai.md'))).toEqual(['generated-with footer'])
    expect(detectDisclosure('Co-Authored-By: Claude <noreply@anthropic.com>')).toEqual([
      'AI Co-Authored-By trailer'
    ])
    expect(detectDisclosure('I drafted this with the help of AI and edited it.')).toEqual([
      'AI-use statement'
    ])
  })

  it('ignores human co-authors and passing mentions', () => {
    expect(detectDisclosure('Co-authored-by: Jane Doe <jane@example.com>')).toEqual([])
    expect(detectDisclosure('Upgrades the claude client library.')).toEqual([])
  })
})

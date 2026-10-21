import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readConfig } from '../src/config.js'
import { config } from './helpers.js'

describe('readConfig', () => {
  it('uses the documented defaults', () => {
    const cfg = config()
    expect(cfg).toMatchObject({
      model: 'pangram-4',
      metric: 'fraction_ai',
      threshold: 0.5,
      mode: 'warn',
      minWords: 50,
      maxWords: 2000,
      stripTemplate: true,
      skipBots: true,
      skipLabel: 'skip-ai-check',
      comment: 'always',
      failOnError: false,
      timeoutSeconds: 60,
      heuristics: 'signal',
      scanOn: null,
      apiUrl: 'https://text.external-api.pangram.com'
    })
    expect(cfg.messages.helpUrl).toBe('https://github.com/mwarkentin/lazy-dog#false-positives')
  })

  it('points help-url at the repository the action runs from', () => {
    const cfg = readConfig(() => '', { GITHUB_ACTION_REPOSITORY: 'getsentry/lazy-dog' })
    expect(cfg.messages.helpUrl).toBe('https://github.com/getsentry/lazy-dog#false-positives')
  })

  it('parses lists, percentages and comment modes', () => {
    const cfg = config({
      threshold: '35%',
      'skip-authors': '@getsantry, Sentry-Junior\nrenovate',
      comment: 'on-flag',
      'scan-on': 'opened, ready_for_review'
    })
    expect(cfg.threshold).toBeCloseTo(0.35)
    expect(cfg.skipAuthors).toEqual(['getsantry', 'sentry-junior', 'renovate'])
    expect(cfg.comment).toBe('on-flag')
    expect(cfg.scanOn).toEqual(['opened', 'ready_for_review'])
  })

  it('compiles strip-patterns, with or without /slashes/', () => {
    const cfg = config({ 'strip-patterns': '^Deploy:.*$\n/ticket \\d+/i\n' })
    expect(cfg.stripPatterns.map(String)).toEqual(['/^Deploy:.*$/gm', '/ticket \\d+/gi'])
  })

  it.each([
    ['threshold', '1.5'],
    ['metric', 'fraction_robot'],
    ['mode', 'block'],
    ['comment', 'sometimes'],
    ['min-words', '-1'],
    ['max-words', '10'],
    ['timeout-seconds', '0'],
    ['skip-bots', 'yes'],
    ['strip-patterns', '(unclosed']
  ])('rejects %s=%s', (name, value) => {
    expect(() => config({ [name]: value })).toThrow(/./)
  })

  it('warns about unknown scan-on events', () => {
    const warnings: string[] = []
    readConfig(
      (n) => (n === 'scan-on' ? 'opened,pushed' : ''),
      {},
      (m) => warnings.push(m)
    )
    expect(warnings).toEqual([expect.stringContaining('"pushed"')])
  })

  it('reads exactly the inputs action.yml declares', () => {
    const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8')
    const section = yml.slice(yml.indexOf('\ninputs:'), yml.indexOf('\noutputs:'))
    const declared = [...section.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]).sort()
    const read = new Set<string>()
    readConfig((name) => {
      read.add(name)
      return ''
    })
    expect([...read].sort()).toEqual(declared)
  })
})

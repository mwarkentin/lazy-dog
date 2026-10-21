import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cleanBody } from '../src/clean.js'
import { runHeuristics } from '../src/heuristics.js'
import {
  DEFAULT_BYPASS_TEMPLATE,
  DEFAULT_FAILURE_TEMPLATE,
  DEFAULT_PASS_TEMPLATE,
  renderMessage,
  resolveTemplates,
  type MessageContext
} from '../src/messages.js'
import { commentBody, renderSummary } from '../src/report.js'
import { summarize } from '../src/result.js'
import { config, fixture, SUCCESS } from './helpers.js'

const clean = cleanBody(fixture('ai.md'))
const heuristics = runHeuristics(clean.full, clean.totalWords, {
  additions: 2,
  deletions: 1,
  changedFiles: 1
})
const result = summarize(SUCCESS)

function ctx(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    cfg: config(),
    result,
    score: result.fractionAi,
    heuristics,
    author: 'octocat',
    wordCount: clean.wordCount,
    diffLines: 3,
    ...overrides
  }
}

const templates = resolveTemplates(config(), null, () => {})

describe('golden comments', () => {
  it('flagged (default template)', async () => {
    const text = renderMessage('flagged', ctx(), templates)
    await expect(text).toMatchFileSnapshot('./golden/flagged.md')
  })

  it('flagged with Sentry-style policy link and footer', async () => {
    const cfg = config({
      'policy-url': 'https://example.com/ai-policy',
      'message-footer':
        'We check PR descriptions because reviewers rely on them to understand intent.\nSee our [AI use policy]({{policy_url}}). Questions: #ops in Slack.'
    })
    const text = renderMessage(
      'flagged',
      ctx({ cfg }),
      resolveTemplates(cfg, null, () => {})
    )
    await expect(text).toMatchFileSnapshot('./golden/flagged-policy.md')
  })

  it('passed', async () => {
    const passing = { ...result, fractionAi: 0.12 }
    const text = renderMessage('passed', ctx({ result: passing, score: 0.12 }), templates)
    await expect(text).toMatchFileSnapshot('./golden/passed.md')
  })

  it('bypassed, with and without a score', async () => {
    const scored = renderMessage('bypassed', ctx({ bypassedBy: 'maintainer' }), templates)
    await expect(scored).toMatchFileSnapshot('./golden/bypassed.md')
    const unscored = renderMessage(
      'bypassed',
      ctx({ result: undefined, score: undefined, bypassedBy: undefined }),
      templates
    )
    await expect(unscored).toMatchFileSnapshot('./golden/bypassed-unscored.md')
  })

  it('skipped and error states', async () => {
    const skipped = renderMessage('skipped', ctx({ skipReason: 'too-short' }), templates)
    await expect(skipped).toMatchFileSnapshot('./golden/skipped.md')
    const error = renderMessage('error', ctx({ errorKind: 'credits' }), templates)
    await expect(error).toMatchFileSnapshot('./golden/error.md')
  })

  it('full comment body, with the hidden hash marker', async () => {
    const text = renderMessage('flagged', ctx(), templates)
    const body = commentBody(text, { hash: clean.hash, model: 'pangram-4', result }, 'test-key')
    await expect(body).toMatchFileSnapshot('./golden/comment-body.md')
  })

  it('job summary', async () => {
    const message = renderMessage('flagged', ctx(), templates)
    const summary = renderSummary({
      state: 'flagged',
      message,
      action: 'opened',
      metric: 'fraction_ai',
      threshold: 0.5,
      model: 'pangram-4',
      score: result.fractionAi,
      result,
      source: 'pangram',
      wordCount: clean.wordCount,
      totalWords: clean.totalWords,
      hash: clean.hash,
      heuristics,
      heuristicsMode: 'signal',
      disclosures: ['generated-with footer'],
      bypassed: false
    })
    await expect(summary).toMatchFileSnapshot('./golden/summary.md')
  })
})

describe('messages', () => {
  it('quotes the flagged window only inside a code span', () => {
    const hostile = {
      ...result,
      quote: '<img src=x onerror=alert(1)> @everyone ` **bold**'
    }
    const text = renderMessage('flagged', ctx({ result: hostile }), templates)
    expect(text).toContain(
      '- Most AI-like passage: ``<img src=x onerror=alert(1)> @everyone ` **bold**``'
    )
  })

  it('escapes the author login', () => {
    const cfg = config({ 'failure-message': 'Hi {{author}}, {{bypass_label}}' })
    const text = renderMessage(
      'flagged',
      ctx({ cfg, author: 'evil<b>' }),
      resolveTemplates(cfg, null, () => {})
    )
    expect(text).toBe('Hi @evil&lt;b&gt;, skip-ai-check')
  })

  it('renders the real bypass label name', () => {
    const cfg = config({ 'skip-label': 'ai-ok' })
    const text = renderMessage(
      'flagged',
      ctx({ cfg }),
      resolveTemplates(cfg, null, () => {})
    )
    expect(text).toContain('**Add the `ai-ok` label**')
  })

  it('warns when a custom failure template drops {{bypass_label}}', () => {
    const warnings: string[] = []
    resolveTemplates(config({ 'failure-message': 'Flagged: {{score}}' }), null, (m) =>
      warnings.push(m)
    )
    expect(warnings).toEqual([expect.stringContaining('{{bypass_label}}')])
  })

  it('prefers failure-message over failure-message-file', () => {
    const warnings: string[] = []
    const cfg = config({
      'failure-message': 'inline {{bypass_label}}',
      'failure-message-file': '.github/ai-check/failure.md'
    })
    expect(resolveTemplates(cfg, 'from file', (m) => warnings.push(m)).failure).toBe(
      'inline {{bypass_label}}'
    )
    expect(warnings).toHaveLength(1)
  })

  it('ships the default templates as files', () => {
    const read = (name: string): string =>
      readFileSync(new URL(`../templates/${name}`, import.meta.url), 'utf8')
    expect(read('failure.md')).toBe(DEFAULT_FAILURE_TEMPLATE)
    expect(read('pass.md')).toBe(DEFAULT_PASS_TEMPLATE)
    expect(read('bypass.md')).toBe(DEFAULT_BYPASS_TEMPLATE)
  })
})

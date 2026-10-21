import { describe, expect, it } from 'vitest'
import {
  cleanBody,
  countWords,
  hashText,
  stripCommentsAndCode,
  templateLines,
  truncateWords
} from '../src/clean.js'
import { fixture } from './helpers.js'

const template = templateLines(fixture('pull_request_template.md'))

describe('cleanBody', () => {
  it('handles an empty body', () => {
    const r = cleanBody('')
    expect(r.text).toBe('')
    expect(r.wordCount).toBe(0)
    expect(r.hash).toBe(hashText(''))
  })

  it('reduces a template-only body to nothing', () => {
    const r = cleanBody(fixture('template-only.md'), { templateLines: template })
    expect(r.text).toBe('')
    expect(r.wordCount).toBe(0)
  })

  it('keeps the prose of a filled-in template and drops the boilerplate', () => {
    const r = cleanBody(fixture('human.md'), { templateLines: template })
    expect(r.text).toMatch(/^Bumps the snuba consumer memory limit/)
    expect(r.text).not.toMatch(/## Summary|Checklist|added or updated tests|<!--/)
    expect(r.text).not.toMatch(/https?:|INC-482|#9876/)
    expect(r.text).toContain('Applied it to the canary pod')
  })

  it('without the template, headings and checklist lines count as words', () => {
    const withTemplate = cleanBody(fixture('human.md'), { templateLines: template })
    const without = cleanBody(fixture('human.md'))
    expect(without.wordCount).toBeGreaterThan(withTemplate.wordCount)
  })

  it('drops fenced code of every flavour, including unclosed fences', () => {
    const r = cleanBody(fixture('code-heavy.md'))
    expect(r.text).toBe('Fixes the retry loop in the uploader.\n\nLogs from before:')
    expect(cleanBody('Intro\n\n```\nnever closed\nstill code').text).toBe('Intro')
  })

  it('removes HTML comments, including multi-line and unterminated ones', () => {
    const body =
      'Keep <!-- inline --> this\n<!--\nmulti\nline\n-->\nand this\n<!-- unterminated\nhidden'
    expect(cleanBody(body).text).toBe('Keep this\nand this')
  })

  it("doesn't let a fence inside a comment swallow the text after it", () => {
    const body = '<!--\n```\n-->\nVisible text after the comment'
    expect(stripCommentsAndCode(body).trim()).toBe('Visible text after the comment')
  })

  it('keeps link text but drops URLs, images, autolinks and ticket IDs', () => {
    const body =
      'See [the runbook](https://example.com/rb) and ![graph](https://img/x.png) <https://a.b/c>.\nFixes OPS-1234, getsentry/ops#99 and #12. Also https://example.com/x?y=1 and www.example.com.'
    expect(cleanBody(body).text).toBe('See the runbook and .\nFixes , and . Also and .')
  })

  it('strips AI disclosure footers from the scored text', () => {
    const r = cleanBody(fixture('ai.md'))
    expect(r.text).not.toMatch(/Generated with/)
  })

  it('applies strip-patterns', () => {
    const r = cleanBody('Deploy note: ignore me\nReal words here', {
      stripPatterns: [/^Deploy note:.*$/gm]
    })
    expect(r.text).toBe('Real words here')
  })

  it('collapses whitespace so formatting-only edits hash the same', () => {
    const a = cleanBody('One  two\tthree\n\n\n\nfour   ')
    const b = cleanBody('One two three\n\nfour')
    expect(a.text).toBe(b.text)
    expect(a.hash).toBe(b.hash)
  })

  it('counts words in non-English text', () => {
    const r = cleanBody(fixture('non-english.md'))
    // Japanese has no spaces; a whitespace split would see one "word" per sentence.
    expect(r.wordCount).toBeGreaterThan(40)
    expect(countWords('Diese Änderung erhöht das Speicherlimit')).toBe(5)
  })

  it('truncates long bodies at max-words and hashes the truncated text', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ')
    const r = cleanBody(body, { maxWords: 2000 })
    expect(r.totalWords).toBe(3000)
    expect(r.wordCount).toBe(2000)
    expect(r.truncated).toBe(true)
    expect(r.text.endsWith('word1999')).toBe(true)
    expect(r.hash).toBe(hashText(r.text))
    expect(r.full.endsWith('word2999')).toBe(true)
  })
})

describe('templateLines', () => {
  it('ignores comments and normalises checkboxes and case', () => {
    expect([...template]).toEqual([
      '## summary',
      '## how was this tested?',
      '## checklist',
      '- [ ] i added or updated tests',
      '- [ ] i updated the runbook if behaviour changed',
      '- [ ] this change is safe to roll back'
    ])
  })
})

describe('truncateWords', () => {
  it('returns short text unchanged', () => {
    expect(truncateWords('a b c', 5)).toBe('a b c')
  })
})

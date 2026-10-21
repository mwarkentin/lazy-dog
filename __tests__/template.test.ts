import { describe, expect, it } from 'vitest'
import { codeSpan, escapeMarkdown, renderTemplate } from '../src/template.js'

describe('renderTemplate', () => {
  it('escapes plain values and inserts raw ones as is', () => {
    const out = renderTemplate('{{a}} and {{ b }}', {
      a: '<img src=x onerror=alert(1)> **bold**',
      b: { raw: '**bold**' }
    })
    expect(out).toBe('&lt;img src=x onerror=alert\\(1\\)&gt; \\*\\*bold\\*\\* and **bold**')
  })

  it('leaves unknown placeholders and reports them', () => {
    const unknown: string[] = []
    expect(renderTemplate('Hi {{nope}}', {}, (n) => unknown.push(n))).toBe('Hi {{nope}}')
    expect(unknown).toEqual(['nope'])
  })

  it('collapses blank lines left by empty values', () => {
    expect(renderTemplate('a\n\n{{x}}\n\nb', { x: '' })).toBe('a\n\nb')
  })
})

describe('escapeMarkdown', () => {
  it('keeps logins usable as mentions', () => {
    expect(escapeMarkdown('octo-cat')).toBe('octo-cat')
    expect(escapeMarkdown('renovate[bot]')).toBe('renovate\\[bot\\]')
  })
})

describe('codeSpan', () => {
  it('uses a fence longer than any backtick run and flattens newlines', () => {
    expect(codeSpan('plain')).toBe('`plain`')
    expect(codeSpan('a `b` c')).toBe('``a `b` c``')
    expect(codeSpan('`edge`')).toBe('`` `edge` ``')
    expect(codeSpan('line one\n\n# not a heading')).toBe('`line one # not a heading`')
  })
})

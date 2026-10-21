import { createHash } from 'node:crypto'
import { isDisclosureLine } from './disclosure.js'

export interface CleanOptions {
  /** Normalised lines of the repo's PR template(s); see templateLines(). */
  templateLines?: ReadonlySet<string>
  /** Extra patterns to delete (from the strip-patterns input). */
  stripPatterns?: readonly RegExp[]
  /** Truncate the scored text after this many words. */
  maxWords?: number
}

export interface CleanResult {
  /** Cleaned text with paragraph and list structure kept; heuristics read this. */
  full: string
  /** `full` truncated to maxWords: what Pangram scores and the hash covers. */
  text: string
  /** Words in `full`. */
  totalWords: number
  /** Words in `text`. */
  wordCount: number
  truncated: boolean
  /** SHA-256 of `text`. */
  hash: string
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const HAS_WORD = /[\p{L}\p{N}]/u

/**
 * Reduce a PR body to the prose its author wrote: drop HTML comments, fenced
 * code, template boilerplate, disclosure footers, custom patterns, URLs and
 * ticket IDs, then collapse whitespace.
 */
export function cleanBody(body: string, opts: CleanOptions = {}): CleanResult {
  let text = stripCommentsAndCode(body.replace(/\r\n?/g, '\n'))

  for (const re of opts.stripPatterns ?? []) {
    re.lastIndex = 0
    text = text.replace(re, '')
  }

  const template = opts.templateLines
  text = text
    .split('\n')
    .filter((line) => !(template?.has(normalizeLine(line)) ?? false) && !isDisclosureLine(line))
    .join('\n')

  text = text
    // Images, then links (keep the link text), reference definitions, autolinks.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '')
    .replace(/<(?:https?|mailto):[^>\s]+>/gi, '')
    // HTML tags (keep their text), bare URLs, emoji shortcodes.
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()[\]]*[^\s<>()[\].,:;!?'"]/gi, '')
    .replace(/:[a-z0-9_+-]+:/g, '')
    // Ticket IDs: OPS-123, owner/repo#123, #123.
    .replace(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, '')
    .replace(/\b[\w.-]+\/[\w.-]+#\d+\b/g, '')
    .replace(/(^|[^\w&/#])#\d+\b/g, '$1')

  const full = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line === '' || HAS_WORD.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const totalWords = countWords(full)
  const max = opts.maxWords ?? Infinity
  const scored = totalWords > max ? truncateWords(full, max) : full
  return {
    full,
    text: scored,
    totalWords,
    wordCount: Math.min(totalWords, max),
    truncated: scored !== full,
    hash: hashText(scored)
  }
}

export function countWords(text: string): number {
  let n = 0
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++
  return n
}

/** The text up to and including its max-th word. */
export function truncateWords(text: string, max: number): string {
  let n = 0
  for (const s of segmenter.segment(text)) {
    if (s.isWordLike && ++n === max) return text.slice(0, s.index + s.segment.length)
  }
  return text
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Lines of a PR template, normalised for matching against body lines. */
export function templateLines(...templates: string[]): Set<string> {
  const lines = new Set<string>()
  for (const template of templates) {
    for (const line of stripCommentsAndCode(template.replace(/\r\n?/g, '\n')).split('\n')) {
      const normalized = normalizeLine(line)
      if (HAS_WORD.test(normalized)) lines.add(normalized)
    }
  }
  return lines
}

/** Case, spacing and checkbox state don't matter when matching template lines. */
export function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/\[[x ]\]/g, '[ ]')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Remove HTML comments and fenced code blocks in one pass, so a fence inside a
 * comment (or a comment opener inside a fence) can't swallow the wrong text.
 * Unclosed comments and fences run to the end, as GitHub renders them.
 */
export function stripCommentsAndCode(md: string): string {
  const out: string[] = []
  let fence: { char: string; len: number } | null = null
  let inComment = false

  for (const original of md.split('\n')) {
    let line = original
    if (fence) {
      const close = /^[\s>]*(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) fence = null
      continue
    }

    let kept = ''
    for (;;) {
      if (inComment) {
        const end = line.indexOf('-->')
        if (end < 0) break
        line = line.slice(end + 3)
        inComment = false
      }
      const start = line.indexOf('<!--')
      if (start < 0) {
        kept += line
        break
      }
      kept += line.slice(0, start)
      line = line.slice(start + 4)
      inComment = true
    }
    // A line that was only a comment disappears instead of leaving a blank.
    if (kept.trim() === '' && original.trim() !== '') continue

    const open = /^[\s>]*(`{3,}|~{3,})(.*)$/.exec(kept)
    // A backtick fence's info string can't contain backticks (CommonMark).
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = { char: open[1]![0]!, len: open[1]!.length }
      continue
    }
    out.push(kept)
  }
  return out.join('\n')
}

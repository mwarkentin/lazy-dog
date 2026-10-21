import type { CommentMode } from './config.js'
import type { GitHubApi, IssueComment } from './github.js'
import type { HeuristicReport } from './heuristics.js'
import { decodeMarker, encodeMarker, type MarkerData } from './marker.js'
import type { CommentState } from './messages.js'
import { percent } from './messages.js'
import type { ScanResult } from './result.js'
import { escapeMarkdown } from './template.js'

export interface StickyComment {
  comment: IssueComment
  /** Cache data; empty unless the marker's signature verified. */
  data: MarkerData
  trusted: boolean
}

/**
 * Find this action's sticky comment. A marker whose signature verifies is
 * ours; failing that (say, the key was rotated), reuse a bot-authored marker
 * comment so we edit it rather than add a second one, but trust none of its data.
 */
export function findSticky(comments: IssueComment[], secret: string): StickyComment | null {
  let fallback: StickyComment | null = null
  for (const comment of comments) {
    const decoded = decodeMarker(comment.body, secret)
    if (!decoded) continue
    if (decoded.trusted) return { comment, data: decoded.data, trusted: true }
    if (!fallback && comment.userType === 'Bot') fallback = { comment, data: {}, trusted: false }
  }
  return fallback
}

export function shouldCreateComment(mode: CommentMode, state: CommentState): boolean {
  if (mode === 'always') return state === 'flagged' || state === 'passed' || state === 'bypassed'
  if (mode === 'on-flag') return state === 'flagged'
  return false
}

export function commentBody(message: string, data: MarkerData, secret: string): string {
  return `${message}\n\n${encodeMarker(data, secret)}`
}

/** Create or edit the sticky comment. Returns its URL, or undefined if none exists. */
export async function upsertComment(
  api: GitHubApi,
  prNumber: number,
  sticky: StickyComment | null,
  body: string,
  create: boolean
): Promise<string | undefined> {
  if (sticky) {
    if (sticky.comment.body === body) return sticky.comment.htmlUrl
    return (await api.updateComment(sticky.comment.id, body)).htmlUrl
  }
  if (!create) return undefined
  return (await api.createComment(prNumber, body)).htmlUrl
}

export interface SummaryInput {
  state: CommentState
  message: string
  action: string
  metric: string
  threshold: number
  model: string
  score?: number
  result?: ScanResult
  source?: 'pangram' | 'cache' | 'stale-cache'
  wordCount?: number
  totalWords?: number
  hash?: string
  heuristics?: HeuristicReport
  heuristicsMode: string
  disclosures: string[]
  bypassedBy?: string
  bypassed: boolean
  skipReason?: string
  error?: string
}

/** Markdown for the job summary: the same message as the comment, plus the details. */
export function renderSummary(s: SummaryInput): string {
  const rows: [string, string][] = [['Event', code(s.action || 'unknown')]]
  rows.push(['Outcome', s.skipReason ? `${s.state} (${code(s.skipReason)})` : s.state])
  if (s.error) rows.push(['Error', escapeMarkdown(s.error)])
  if (s.score !== undefined) {
    rows.push([
      'Score',
      `${percent(s.score)} ${code(s.metric)} (threshold ${percent(s.threshold)})`
    ])
  }
  if (s.result) {
    const r = s.result
    rows.push(['fraction_ai', r.fractionAi.toFixed(4)])
    rows.push(['fraction_ai_assisted', r.fractionAiAssisted.toFixed(4)])
    rows.push(['fraction_human', r.fractionHuman.toFixed(4)])
    rows.push(['Prediction', escapeMarkdown(r.prediction || 'n/a')])
    rows.push([
      'Segments',
      `${r.segments.ai} AI-generated, ${r.segments.assisted} AI-assisted, ${r.segments.total} total`
    ])
    rows.push(['Model', `${code(s.model)} (version ${escapeMarkdown(r.version || 'unknown')})`])
  }
  if (s.source) {
    const sources = {
      pangram: 'Pangram API',
      cache: 'cached result for identical text (no API call)',
      'stale-cache': 'cached result for an earlier version of the text (no API call)'
    }
    rows.push(['Source', sources[s.source]])
  }
  if (s.wordCount !== undefined) {
    const truncated =
      s.totalWords !== undefined && s.totalWords > s.wordCount
        ? ` (truncated from ${s.totalWords})`
        : ''
    rows.push(['Words scored', `${s.wordCount}${truncated}`])
  }
  if (s.hash) rows.push(['Text hash', code(s.hash.slice(0, 12))])
  rows.push(['Disclosed AI use', s.disclosures.length ? s.disclosures.join(', ') : 'no'])
  if (s.bypassed) rows.push(['Bypassed by', s.bypassedBy ? `@${s.bypassedBy}` : 'unknown'])

  let out = `${s.message}\n\n<details><summary>Details</summary>\n\n| | |\n| --- | --- |\n`
  out += rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')
  if (s.heuristics) {
    out += `\n\nHeuristics (${s.heuristicsMode} mode): score ${s.heuristics.score.toFixed(2)}\n\n`
    out += '| Signal | Fired | Detail |\n| --- | --- | --- |\n'
    out += s.heuristics.signals
      .map((sig) => `| ${code(sig.id)} | ${sig.fired ? 'yes' : 'no'} | ${sig.detail} |`)
      .join('\n')
  }
  return `${out}\n\n</details>\n`
}

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``

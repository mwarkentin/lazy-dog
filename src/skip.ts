import type { Config } from './config.js'

/** The parts of a pull request this action reads, from the event payload or REST. */
export interface PullRequestInfo {
  number: number
  state: string
  draft: boolean
  body: string
  authorLogin: string
  authorType: string
  labels: string[]
  additions: number
  deletions: number
  changedFiles: number
  baseRef: string
  headSha: string
  htmlUrl: string
}

export type SkipReason =
  | 'not-a-pull-request'
  | 'closed'
  | 'draft'
  | 'bot'
  | 'skip-author'
  | 'too-short'
  | 'disclosed'
  | 'no-pangram-key'
  | 'bypass-label'
  | 'not-scanned-on-event'
  | 'below-heuristic-threshold'
  | 'api-error'

/** Parse a REST or webhook pull request object. */
export function toPullRequestInfo(pr: unknown): PullRequestInfo | null {
  if (typeof pr !== 'object' || pr === null) return null
  const p = pr as Record<string, unknown>
  if (typeof p.number !== 'number') return null
  const user = (p.user ?? {}) as Record<string, unknown>
  const base = (p.base ?? {}) as Record<string, unknown>
  const head = (p.head ?? {}) as Record<string, unknown>
  const labels = Array.isArray(p.labels) ? p.labels : []
  return {
    number: p.number,
    state: str(p.state) || 'open',
    draft: p.draft === true,
    body: str(p.body),
    authorLogin: str(user.login),
    authorType: str(user.type),
    labels: labels
      .map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name)))
      .filter(Boolean),
    additions: num(p.additions),
    deletions: num(p.deletions),
    changedFiles: num(p.changed_files),
    baseRef: str(base.ref),
    headSha: str(head.sha),
    htmlUrl: str(p.html_url)
  }
}

export function isBot(login: string, type: string): boolean {
  return type === 'Bot' || login.toLowerCase().endsWith('[bot]')
}

/** Rules that skip a PR before its body is read: state, draft, bot, allow-list. */
export function authorSkip(pr: PullRequestInfo, cfg: Config): SkipReason | null {
  if (pr.state === 'closed') return 'closed'
  if (pr.draft) return 'draft'
  if (cfg.skipBots && isBot(pr.authorLogin, pr.authorType)) return 'bot'
  if (cfg.skipAuthors.includes(pr.authorLogin.toLowerCase())) return 'skip-author'
  return null
}

export function hasBypassLabel(pr: PullRequestInfo, label: string): boolean {
  const wanted = label.toLowerCase()
  return pr.labels.some((l) => l.toLowerCase() === wanted)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

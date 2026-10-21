import type { Config } from './config.js'
import type { HeuristicReport } from './heuristics.js'
import { metricLabel, type ScanResult } from './result.js'
import type { SkipReason } from './skip.js'
import { codeSpan, placeholdersIn, renderTemplate, type Placeholders } from './template.js'

// Keep these in sync with templates/*.md (a test enforces it).
export const DEFAULT_FAILURE_TEMPLATE = `### AI description check: flagged

Pangram estimates **{{score}} of this description is {{metric_label}}** (threshold {{threshold}}, model {{model}}).

What stood out:
{{signals}}

This is a best-effort check, and detectors can be wrong. To get this through, either:
1. **Rewrite the description** in your own words: what changed, why, and how it was tested. Short is fine. The check re-runs when you save the edit.
2. **Add the \`{{bypass_label}}\` label** if you believe this is a false positive or the description is fine as is. No justification needed.

{{policy_link}}

Questions or false positives: {{help_url}}
`

export const DEFAULT_PASS_TEMPLATE = `### AI description check: passed

Pangram estimates {{score}} of this description is {{metric_label}}, under the {{threshold}} threshold (model {{model}}).
`

export const DEFAULT_BYPASS_TEMPLATE = `### AI description check: bypassed

Bypassed via the \`{{bypass_label}}\` label by {{bypassed_by}}, so this check passes. {{score_summary}}

Remove the label to run the check normally.
`

export type CommentState = 'flagged' | 'passed' | 'bypassed' | 'skipped' | 'error'

export interface Templates {
  failure: string
  pass: string
  bypass: string
}

export interface MessageContext {
  cfg: Config
  result?: ScanResult
  score?: number
  heuristics?: HeuristicReport
  author: string
  bypassedBy?: string
  wordCount: number
  diffLines: number
  skipReason?: SkipReason
  errorKind?: string
  /** Set when the result was scored on an earlier version of the text (scan-on). */
  stale?: boolean
}

/** Pick custom or default templates; warn about custom ones that strand authors. */
export function resolveTemplates(
  cfg: Config,
  failureFromFile: string | null,
  warn: (message: string) => void
): Templates {
  let failure = DEFAULT_FAILURE_TEMPLATE
  if (cfg.messages.failureMessage) {
    if (cfg.messages.failureMessageFile) {
      warn('Both failure-message and failure-message-file are set; using failure-message.')
    }
    failure = cfg.messages.failureMessage
  } else if (failureFromFile) {
    failure = failureFromFile
  }
  if (failure !== DEFAULT_FAILURE_TEMPLATE && !placeholdersIn(failure).includes('bypass_label')) {
    warn(
      'The custom failure message does not mention {{bypass_label}}, so flagged authors are not told how to get through.'
    )
  }
  return {
    failure,
    pass: cfg.messages.passMessage || DEFAULT_PASS_TEMPLATE,
    bypass: cfg.messages.bypassMessage || DEFAULT_BYPASS_TEMPLATE
  }
}

export function renderMessage(
  state: CommentState,
  ctx: MessageContext,
  templates: Templates,
  warn: (message: string) => void = () => {}
): string {
  const values = placeholders(ctx)
  const unknown = new Set<string>()
  const render = (template: string): string =>
    renderTemplate(template, values, (name) => unknown.add(name))

  let body: string
  if (state === 'flagged') body = render(templates.failure)
  else if (state === 'passed') body = render(templates.pass)
  else if (state === 'bypassed') body = render(templates.bypass)
  else if (state === 'skipped') {
    body = `### AI description check: skipped\n\n${skipText(ctx.skipReason, ctx.cfg)}`
  } else {
    body = `### AI description check: not run\n\n${errorText(ctx)}`
  }

  if (ctx.stale && (state === 'flagged' || state === 'passed')) {
    const events = (ctx.cfg.scanOn ?? []).map((e) => `\`${e}\``).join(', ')
    body += `\n\n_This score is from an earlier version of the description; this repository only scans on ${events}._`
  }

  const { header, footer } = ctx.cfg.messages
  const parts = [header ? render(header) : '', body, footer ? render(footer) : '']
  for (const name of unknown) warn(`Unknown placeholder {{${name}}} left as is.`)
  return parts.filter(Boolean).join('\n\n')
}

export function placeholders(ctx: MessageContext): Placeholders {
  const { cfg, result, score } = ctx
  const label = metricLabel(cfg.metric)
  const scoreText = score === undefined ? 'n/a' : percent(score)
  const threshold = percent(cfg.threshold)
  const summary =
    score === undefined
      ? 'The description was not scored.'
      : `Pangram estimates ${scoreText} of this description is ${label} (threshold ${threshold}, model ${cfg.model}).`
  return {
    score: { raw: scoreText },
    metric: { raw: cfg.metric },
    metric_label: { raw: label },
    threshold: { raw: threshold },
    model: { raw: cfg.model },
    model_version: result?.version ?? '',
    prediction: result?.prediction ?? '',
    signals: { raw: renderSignals(result, ctx.heuristics) },
    bypass_label: { raw: cfg.skipLabel },
    bypassed_by: ctx.bypassedBy ? `@${ctx.bypassedBy}` : 'a maintainer',
    policy_url: { raw: cfg.messages.policyUrl },
    policy_link: { raw: cfg.messages.policyUrl ? `Why we check: ${cfg.messages.policyUrl}` : '' },
    help_url: { raw: cfg.messages.helpUrl },
    author: ctx.author ? `@${ctx.author}` : '',
    word_count: { raw: String(ctx.wordCount) },
    diff_lines: { raw: String(ctx.diffLines) },
    heuristic_score: { raw: ctx.heuristics ? ctx.heuristics.score.toFixed(2) : '' },
    score_summary: { raw: summary }
  }
}

/** Bulleted list of what fired: Pangram's segments, one quoted passage, heuristics. */
export function renderSignals(result?: ScanResult, heuristics?: HeuristicReport): string {
  const lines: string[] = []
  if (result) {
    const { total, ai, aiHigh, assisted, assistedHigh } = result.segments
    const confidence = (n: number, high: number): string =>
      high === 0 ? '' : high === n ? ' (high confidence)' : ` (${high} with high confidence)`
    if (ai > 0) {
      lines.push(`- ${ai} of ${total} segments classified AI-generated${confidence(ai, aiHigh)}`)
    }
    if (assisted > 0) {
      lines.push(
        `- ${assisted} of ${total} segments classified AI-assisted${confidence(assisted, assistedHigh)}`
      )
    }
    if (result.quote) lines.push(`- Most AI-like passage: ${codeSpan(result.quote)}`)
  }
  for (const signal of heuristics?.signals ?? []) {
    if (signal.fired) lines.push(`- ${signal.detail}`)
  }
  if (!lines.length) lines.push('- Overall score above the threshold')
  return lines.join('\n')
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

export function skipText(reason: SkipReason | undefined, cfg: Config): string {
  switch (reason) {
    case 'closed':
      return 'Closed pull requests are not checked.'
    case 'draft':
      return 'Draft pull requests are not checked. The check runs when this one is marked ready for review.'
    case 'bot':
    case 'skip-author':
      return "This pull request's author is excluded from the check."
    case 'too-short':
      return `After removing template text, comments and code, the description is under ${cfg.minWords} words, which is too short to score reliably.`
    case 'disclosed':
      return 'The description discloses AI use, and this repository does not check disclosed descriptions.'
    case 'no-api-key':
      return 'No Pangram API key was available to this run, so the description was not scored.'
    case 'not-scanned-on-event':
      return 'The description has not been scored yet; this repository only scans on some pull request events.'
    case 'below-heuristic-threshold':
      return 'Local heuristics found nothing worth a Pangram check.'
    default:
      return 'The description was not scored.'
  }
}

const ERROR_REASONS: Record<string, string> = {
  auth: 'the check is misconfigured',
  forbidden: 'the check is misconfigured',
  invalid: 'Pangram rejected the request',
  credits: 'the Pangram account is out of credits',
  'rate-limited': "Pangram's rate limit was hit",
  timeout: 'Pangram took too long to respond',
  'task-failed': "Pangram couldn't process the text"
}

function errorText(ctx: MessageContext): string {
  const why = ERROR_REASONS[ctx.errorKind ?? ''] ?? 'Pangram was unavailable'
  const then = ctx.cfg.failOnError
    ? 'This check fails until it can run.'
    : 'This check passes for now and runs again when the description is edited.'
  return `This description wasn't scored: ${why}. ${then}`
}

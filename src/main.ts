import { cleanBody, type CleanResult } from './clean.js'
import { ConfigError, readConfig, type Config } from './config.js'
import { detectDisclosure } from './disclosure.js'
import type { GitHubApi } from './github.js'
import { workspaceHasHead } from './guard.js'
import { runHeuristics, type HeuristicReport } from './heuristics.js'
import type { MarkerData } from './marker.js'
import {
  percent,
  renderMessage,
  resolveTemplates,
  type CommentState,
  type MessageContext
} from './messages.js'
import { PangramError, type DetectOptions, type PangramResult } from './pangram.js'
import {
  commentBody,
  findSticky,
  renderSummary,
  shouldCreateComment,
  upsertComment,
  type StickyComment
} from './report.js'
import { loadFailureTemplate, loadTemplateLines } from './repo.js'
import { metricLabel, metricValue, summarize, type ScanResult } from './result.js'
import {
  authorSkip,
  hasBypassLabel,
  toPullRequestInfo,
  type PullRequestInfo,
  type SkipReason
} from './skip.js'

export interface Logger {
  info(message: string): void
  warning(message: string): void
  error(message: string): void
}

/** Everything run() touches outside its own logic, so tests can supply fakes. */
export interface Deps {
  getInput: (name: string) => string
  eventName: string
  payload: Record<string, unknown>
  env: Record<string, string | undefined>
  createApi: (token: string) => GitHubApi
  detect: (text: string, opts: DetectOptions) => Promise<PangramResult>
  log: Logger
  setOutput: (name: string, value: string) => void
  setFailed: (message: string) => void
  setSecret: (secret: string) => void
  writeSummary: (markdown: string) => Promise<void>
}

export interface Outcome {
  state: CommentState
  outputs: Record<string, string>
  message: string
  commentUrl?: string
}

interface Evaluation {
  action: string
  pr: PullRequestInfo | null
  api: GitHubApi | null
  sticky: StickyComment | null
  bypassed: boolean
  bypassedBy?: string
  skipReason?: SkipReason
  clean?: CleanResult
  heuristics?: HeuristicReport
  disclosures: string[]
  result?: ScanResult
  source?: 'pangram' | 'cache' | 'stale-cache'
  /** Cache to write into the sticky comment's marker. */
  markerData: MarkerData
  error?: Error
}

/** Skips decided before the scan; a bypass label doesn't change these. */
const ELIGIBILITY_SKIPS: SkipReason[] = [
  'not-a-pull-request',
  'closed',
  'draft',
  'bot',
  'skip-author',
  'too-short',
  'disclosed'
]

export async function run(deps: Deps): Promise<Outcome | undefined> {
  let cfg: Config
  try {
    cfg = readConfig(deps.getInput, deps.env, (m) => deps.log.warning(m))
  } catch (err) {
    deps.setFailed(err instanceof ConfigError ? err.message : `Invalid input: ${message(err)}`)
    return undefined
  }
  if (cfg.apiKey) deps.setSecret(cfg.apiKey)

  try {
    const ev = await evaluate(cfg, deps)
    return await publish(cfg, deps, ev)
  } catch (err) {
    const text = `AI description check hit an unexpected error: ${message(err)}`
    if (cfg.failOnError) deps.setFailed(text)
    else deps.log.error(`${text} (passing because fail-on-error is false)`)
    return undefined
  }
}

async function evaluate(cfg: Config, deps: Deps): Promise<Evaluation> {
  const { log, payload } = deps
  const action = typeof payload.action === 'string' ? payload.action : ''
  const ev: Evaluation = {
    action,
    pr: null,
    api: null,
    sticky: null,
    bypassed: false,
    disclosures: [],
    markerData: {}
  }
  const skip = (reason: SkipReason): Evaluation => {
    ev.skipReason = reason
    ev.markerData = ev.sticky?.trusted ? ev.sticky.data : {}
    log.info(`Skipped: ${reason}.`)
    return ev
  }

  let pr = toPullRequestInfo(payload.pull_request)
  if (!pr) {
    log.warning(
      `This action checks pull request descriptions; the "${deps.eventName}" event has no pull request.`
    )
    return skip('not-a-pull-request')
  }

  if (
    deps.eventName === 'pull_request_target' &&
    workspaceHasHead(deps.env.GITHUB_WORKSPACE, pr.headSha)
  ) {
    log.warning(
      'The PR head commit is in the workspace. This action never needs actions/checkout; checking out PR code under pull_request_target exposes your secrets to it. Remove the checkout step from this job.'
    )
  }

  const api = cfg.githubToken ? deps.createApi(cfg.githubToken) : null
  ev.api = api
  if (api) {
    // Re-fetch so labels and edits made since the event (or a re-run) are seen.
    try {
      pr = (await api.getPullRequest(pr.number)) ?? pr
    } catch (err) {
      log.warning(`Could not re-fetch PR #${pr.number}, using the event payload: ${message(err)}`)
    }
  } else {
    log.warning('github-token is empty: no PR comment, template stripping or fresh PR data.')
  }
  ev.pr = pr

  if (action === 'edited' && !(payload.changes as Record<string, unknown> | undefined)?.body) {
    log.info('Only the title changed; reusing the cached result if there is one.')
  }

  if (api && cfg.comment !== 'off') {
    try {
      ev.sticky = findSticky(await api.listComments(pr.number), cfg.apiKey)
    } catch (err) {
      log.warning(`Could not list PR comments: ${message(err)}`)
    }
  }

  const early = authorSkip(pr, cfg)
  if (early) return skip(early)

  ev.bypassed = hasBypassLabel(pr, cfg.skipLabel)
  if (ev.bypassed) ev.bypassedBy = await bypassActor(cfg, deps, api, pr)

  const lines = cfg.stripTemplate && api ? await loadTemplateLines(api, pr.baseRef, log) : undefined
  const clean = cleanBody(pr.body, {
    templateLines: lines,
    stripPatterns: cfg.stripPatterns,
    maxWords: cfg.maxWords
  })
  ev.clean = clean
  ev.disclosures = detectDisclosure(pr.body)
  if (cfg.heuristics !== 'off') ev.heuristics = runHeuristics(clean.full, clean.totalWords, pr)
  log.info(
    `PR #${pr.number} (${action || deps.eventName}): ${clean.totalWords} words after cleaning${clean.truncated ? `, truncated to ${clean.wordCount}` : ''}; hash ${clean.hash.slice(0, 12)}.`
  )

  if (clean.totalWords < cfg.minWords) return skip('too-short')
  if (cfg.skipIfDisclosed && ev.disclosures.length) return skip('disclosed')

  const cached = ev.sticky?.trusted ? ev.sticky.data : undefined
  if (cached?.result && cached.hash === clean.hash && cached.model === cfg.model) {
    log.info('Description unchanged since the last scan; reusing that result (no Pangram call).')
    ev.result = cached.result
    ev.source = 'cache'
    ev.markerData = cached
    return ev
  }

  if (!cfg.apiKey) {
    log.warning(
      'pangram-api-key is empty (fork PRs get no secrets under pull_request); skipping the scan.'
    )
    return skip('no-api-key')
  }
  if (ev.bypassed && cfg.bypassLabelSkipScan) return skip('bypass-label')
  if (cfg.scanOn && !cfg.scanOn.includes(action)) {
    if (cached?.result && cached.model === cfg.model) {
      log.info(`"${action}" is not in scan-on; reusing the result for an earlier version.`)
      ev.result = cached.result
      ev.source = 'stale-cache'
      ev.markerData = cached
      return ev
    }
    return skip('not-scanned-on-event')
  }
  if (cfg.heuristics === 'gate' && ev.heuristics && ev.heuristics.score < cfg.heuristicThreshold) {
    return skip('below-heuristic-threshold')
  }

  try {
    log.info(`Sending ${clean.wordCount} words to Pangram (model ${cfg.model}).`)
    const raw = await deps.detect(clean.text, {
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.apiUrl,
      timeoutMs: cfg.timeoutSeconds * 1000
    })
    ev.result = summarize(raw)
    ev.source = 'pangram'
    ev.markerData = { hash: clean.hash, model: cfg.model, result: ev.result }
    const r = ev.result
    log.info(
      `Pangram: fraction_ai=${r.fractionAi} fraction_ai_assisted=${r.fractionAiAssisted} fraction_human=${r.fractionHuman} prediction=${r.prediction} version=${r.version}`
    )
  } catch (err) {
    if (!(err instanceof PangramError)) throw err
    ev.error = err
    skip('api-error')
  }
  return ev
}

async function publish(cfg: Config, deps: Deps, ev: Evaluation): Promise<Outcome> {
  const { log } = deps
  const score = ev.result ? metricValue(ev.result, cfg.metric) : undefined
  const verdict = score === undefined ? undefined : score > cfg.threshold ? 'flag' : 'pass'

  let state: CommentState
  if (ev.skipReason && ELIGIBILITY_SKIPS.includes(ev.skipReason)) state = 'skipped'
  else if (ev.bypassed) state = 'bypassed'
  else if (ev.error) state = 'error'
  else if (ev.skipReason) state = 'skipped'
  else state = verdict === 'flag' ? 'flagged' : 'passed'

  const failureFile =
    state === 'flagged' &&
    ev.api &&
    ev.pr &&
    cfg.messages.failureMessageFile &&
    !cfg.messages.failureMessage
      ? await loadFailureTemplate(ev.api, cfg.messages.failureMessageFile, ev.pr.baseRef, log)
      : null
  const templates = resolveTemplates(cfg, failureFile, (m) => log.warning(m))
  const ctx: MessageContext = {
    cfg,
    result: ev.result,
    score,
    heuristics: ev.heuristics,
    author: ev.pr?.authorLogin ?? '',
    bypassedBy: ev.bypassedBy,
    wordCount: ev.clean?.wordCount ?? 0,
    diffLines: ev.pr ? ev.pr.additions + ev.pr.deletions : 0,
    skipReason: ev.skipReason,
    errorKind: ev.error instanceof PangramError ? ev.error.kind : undefined,
    stale: ev.source === 'stale-cache'
  }
  const text = renderMessage(state, ctx, templates, (m) => log.warning(m))

  let commentUrl: string | undefined
  if (ev.api && ev.pr && cfg.comment !== 'off') {
    try {
      commentUrl = await upsertComment(
        ev.api,
        ev.pr.number,
        ev.sticky,
        commentBody(text, ev.markerData, cfg.apiKey),
        shouldCreateComment(cfg.comment, state)
      )
    } catch (err) {
      log.warning(
        `Could not write the PR comment (the job needs pull-requests: write): ${message(err)}`
      )
    }
  }

  try {
    await deps.writeSummary(
      renderSummary({
        state,
        message: text,
        action: ev.action,
        metric: cfg.metric,
        threshold: cfg.threshold,
        model: cfg.model,
        score,
        result: ev.result,
        source: ev.source,
        wordCount: ev.clean?.wordCount,
        totalWords: ev.clean?.totalWords,
        hash: ev.clean?.hash,
        heuristics: ev.heuristics,
        heuristicsMode: cfg.heuristics,
        disclosures: ev.disclosures,
        bypassed: ev.bypassed,
        bypassedBy: ev.bypassedBy,
        skipReason: ev.skipReason,
        error: ev.error?.message
      })
    )
  } catch (err) {
    log.warning(`Could not write the job summary: ${message(err)}`)
  }

  const r = ev.result
  const outputs: Record<string, string> = {
    skipped: String(!r),
    'skip-reason': ev.skipReason ?? '',
    'fraction-ai': r ? String(r.fractionAi) : '',
    'fraction-ai-assisted': r ? String(r.fractionAiAssisted) : '',
    'fraction-human': r ? String(r.fractionHuman) : '',
    prediction: r?.prediction ?? '',
    'word-count': ev.clean ? String(ev.clean.wordCount) : '',
    'model-version': r?.version ?? '',
    verdict: verdict ?? '',
    bypassed: String(ev.bypassed),
    'bypassed-by': ev.bypassedBy ?? '',
    'heuristic-score': ev.heuristics ? ev.heuristics.score.toFixed(2) : '',
    disclosed: String(ev.disclosures.length > 0),
    cached: String(ev.source === 'cache' || ev.source === 'stale-cache'),
    'comment-url': commentUrl ?? ''
  }
  for (const [name, value] of Object.entries(outputs)) deps.setOutput(name, value)

  if (score !== undefined) {
    log.info(
      `Verdict: ${verdict} (${cfg.metric} ${percent(score)} vs threshold ${percent(cfg.threshold)})${ev.bypassed ? `; bypassed by ${ev.bypassedBy ?? 'unknown'}` : ''}.`
    )
  }

  if (state === 'flagged' && cfg.mode === 'fail' && score !== undefined) {
    deps.setFailed(
      `Pangram estimates ${percent(score)} of this PR description is ${metricLabel(cfg.metric)} (threshold ${percent(cfg.threshold)}). See ${commentUrl ?? 'the job summary'} for details and how to get this through.`
    )
  } else if (ev.error) {
    const isConfig = ev.error instanceof PangramError && ev.error.isConfigError
    const note = `Pangram API error: ${ev.error.message}`
    if (state === 'error' && cfg.failOnError) deps.setFailed(note)
    else if (isConfig) log.error(`${note} (not failing: fail-on-error is false)`)
    else log.warning(note)
  }

  return { state, outputs, message: text, commentUrl }
}

async function bypassActor(
  cfg: Config,
  deps: Deps,
  api: GitHubApi | null,
  pr: PullRequestInfo
): Promise<string | undefined> {
  const label = (deps.payload.label as { name?: string } | undefined)?.name
  const sender = (deps.payload.sender as { login?: string } | undefined)?.login
  if (deps.payload.action === 'labeled' && label?.toLowerCase() === cfg.skipLabel.toLowerCase()) {
    return sender
  }
  if (!api) return undefined
  try {
    return (await api.findLabelActor(pr.number, cfg.skipLabel)) ?? undefined
  } catch (err) {
    deps.log.warning(`Could not look up who added ${cfg.skipLabel}: ${message(err)}`)
    return undefined
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

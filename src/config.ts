export type Metric = 'fraction_ai' | 'fraction_ai_assisted' | 'max'
export type Mode = 'warn' | 'fail'
export type HeuristicsMode = 'off' | 'signal' | 'gate'
export type CommentMode = 'always' | 'on-flag' | 'off'

export interface MessageConfig {
  policyUrl: string
  helpUrl: string
  failureMessage: string
  failureMessageFile: string
  header: string
  footer: string
  passMessage: string
  bypassMessage: string
}

export interface Config {
  apiKey: string
  githubToken: string
  apiUrl: string
  model: string
  metric: Metric
  threshold: number
  mode: Mode
  minWords: number
  maxWords: number
  stripTemplate: boolean
  stripPatterns: RegExp[]
  skipBots: boolean
  skipAuthors: string[]
  skipLabel: string
  bypassLabelSkipScan: boolean
  skipIfDisclosed: boolean
  comment: CommentMode
  failOnError: boolean
  timeoutSeconds: number
  heuristics: HeuristicsMode
  heuristicThreshold: number
  /** Event actions that may call Pangram; null means every action. */
  scanOn: string[] | null
  messages: MessageConfig
}

export const DEFAULT_API_URL = 'https://text.external-api.pangram.com'
export const KNOWN_ACTIONS = [
  'opened',
  'edited',
  'reopened',
  'ready_for_review',
  'labeled',
  'unlabeled',
  'synchronize'
]

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export type InputReader = (name: string) => string

/**
 * Reads and validates every action input. Throws ConfigError on values the
 * workflow owner needs to fix; those always fail the step.
 */
export function readConfig(
  getInput: InputReader,
  env: Record<string, string | undefined> = {},
  warn: (message: string) => void = () => {}
): Config {
  const str = (name: string, fallback = ''): string => getInput(name).trim() || fallback

  const actionRepo = env.GITHUB_ACTION_REPOSITORY || 'mwarkentin/lazy-dog'
  const scanOn = list(str('scan-on'))
  for (const action of scanOn) {
    if (!KNOWN_ACTIONS.includes(action)) {
      warn(`scan-on: "${action}" is not a pull_request event type this action handles.`)
    }
  }

  const minWords = int(str('min-words', '50'), 'min-words', 0)
  const maxWords = int(str('max-words', '2000'), 'max-words', 1)
  if (maxWords < minWords) {
    throw new ConfigError(`max-words (${maxWords}) must be at least min-words (${minWords}).`)
  }

  return {
    apiKey: getInput('pangram-api-key').trim(),
    githubToken: str('github-token'),
    apiUrl: str('pangram-api-url', DEFAULT_API_URL).replace(/\/+$/, ''),
    model: str('model', 'pangram-4'),
    metric: oneOf(str('metric', 'fraction_ai'), 'metric', [
      'fraction_ai',
      'fraction_ai_assisted',
      'max'
    ]),
    threshold: fraction(str('threshold', '0.5'), 'threshold'),
    mode: oneOf(str('mode', 'warn'), 'mode', ['warn', 'fail']),
    minWords,
    maxWords,
    stripTemplate: bool(str('strip-template', 'true'), 'strip-template'),
    stripPatterns: patterns(getInput('strip-patterns')),
    skipBots: bool(str('skip-bots', 'true'), 'skip-bots'),
    skipAuthors: list(str('skip-authors')).map((login) => login.replace(/^@/, '').toLowerCase()),
    skipLabel: str('skip-label', 'skip-ai-check'),
    bypassLabelSkipScan: bool(str('bypass-label-skip-scan', 'false'), 'bypass-label-skip-scan'),
    skipIfDisclosed: bool(str('skip-if-disclosed', 'false'), 'skip-if-disclosed'),
    comment: commentMode(str('comment', 'true')),
    failOnError: bool(str('fail-on-error', 'false'), 'fail-on-error'),
    timeoutSeconds: positive(str('timeout-seconds', '60'), 'timeout-seconds'),
    heuristics: oneOf(str('heuristics', 'signal'), 'heuristics', ['off', 'signal', 'gate']),
    heuristicThreshold: fraction(str('heuristic-threshold', '0.25'), 'heuristic-threshold'),
    scanOn: scanOn.length ? scanOn : null,
    messages: {
      policyUrl: str('policy-url'),
      helpUrl: str('help-url', `https://github.com/${actionRepo}#false-positives`),
      // Templates keep their whitespace; only blank values fall back to defaults.
      failureMessage: getInput('failure-message').trim() ? getInput('failure-message') : '',
      failureMessageFile: str('failure-message-file'),
      header: getInput('message-header').trim() ? getInput('message-header') : '',
      footer: getInput('message-footer').trim() ? getInput('message-footer') : '',
      passMessage: getInput('pass-message').trim() ? getInput('pass-message') : '',
      bypassMessage: getInput('bypass-message').trim() ? getInput('bypass-message') : ''
    }
  }
}

function list(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function bool(value: string, name: string): boolean {
  const v = value.toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  throw new ConfigError(`${name} must be "true" or "false", got "${value}".`)
}

function oneOf<T extends string>(value: string, name: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new ConfigError(`${name} must be one of ${allowed.join(', ')}; got "${value}".`)
}

function commentMode(value: string): CommentMode {
  const v = value.toLowerCase()
  if (v === 'true' || v === 'always') return 'always'
  if (v === 'false' || v === 'off') return 'off'
  if (v === 'on-flag') return 'on-flag'
  throw new ConfigError(`comment must be "true", "false" or "on-flag"; got "${value}".`)
}

/** Accepts 0.5 or 50%. */
function fraction(value: string, name: string): number {
  const percent = value.endsWith('%')
  const n = Number(percent ? value.slice(0, -1) : value)
  const v = percent ? n / 100 : n
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new ConfigError(`${name} must be between 0 and 1 (or 0% and 100%); got "${value}".`)
  }
  return v
}

function int(value: string, name: string, min: number): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) {
    throw new ConfigError(`${name} must be a whole number >= ${min}; got "${value}".`)
  }
  return n
}

function positive(value: string, name: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive number; got "${value}".`)
  }
  return n
}

/** One regex per line. Plain lines use flags "gm"; /source/flags syntax is also accepted. */
function patterns(value: string): RegExp[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const literal = /^\/(.+)\/([dgimsuvy]*)$/.exec(line)
      const source = literal ? literal[1]! : line
      const flags = literal ? literal[2]! : 'm'
      try {
        return new RegExp(source, flags.includes('g') ? flags : `${flags}g`)
      } catch (err) {
        throw new ConfigError(
          `strip-patterns: invalid regular expression ${line}: ${(err as Error).message}`
        )
      }
    })
}

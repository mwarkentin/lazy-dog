/**
 * Minimal client for Pangram's async AI-detection REST API: submit a task,
 * then poll it until it reaches a terminal stage.
 */

export interface PangramWindow {
  text: string
  label: string
  ai_assistance_score: number
  confidence: string
  start_index: number
  end_index: number
  word_count: number
  token_length?: number
  is_humanized?: boolean
  humanizer_score?: number
}

export interface PangramResult {
  stage: string
  text: string
  version: string
  headline: string
  prediction: string
  prediction_short: string
  fraction_ai: number
  fraction_ai_assisted: number
  fraction_human: number
  num_ai_segments: number
  num_ai_assisted_segments: number
  num_human_segments: number
  windows: PangramWindow[]
  dashboard_link?: string
}

export type PangramErrorKind =
  | 'auth'
  | 'credits'
  | 'forbidden'
  | 'invalid'
  | 'not-found'
  | 'rate-limited'
  | 'unavailable'
  | 'server'
  | 'client'
  | 'network'
  | 'timeout'
  | 'task-failed'
  | 'bad-response'

export class PangramError extends Error {
  override name = 'PangramError'
  constructor(
    readonly kind: PangramErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message)
  }

  /** Errors the workflow owner has to fix (key, entitlement, model name). */
  get isConfigError(): boolean {
    return this.kind === 'auth' || this.kind === 'forbidden' || this.kind === 'invalid'
  }
}

export interface DetectOptions {
  apiKey: string
  model: string
  baseUrl: string
  /** Total budget for submitting and polling. */
  timeoutMs: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const SUCCESS = 'STAGE_SUCCESS'
const FAILED = 'STAGE_FAILED'
const FIRST_POLL_MS = 1000
const MAX_POLL_MS = 4000
const REQUEST_TIMEOUT_MS = 15000
const SUBMIT_ATTEMPTS = 3

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function detect(text: string, opts: DetectOptions): Promise<PangramResult> {
  const fetchImpl = opts.fetch ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const deadline = now() + opts.timeoutMs
  const remaining = (): number => deadline - now()

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    const budget = remaining()
    if (budget <= 0) throw timeoutError(opts.timeoutMs)
    try {
      return await fetchImpl(`${opts.baseUrl}${path}`, {
        ...init,
        headers: { 'x-api-key': opts.apiKey, ...init.headers },
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, budget))
      })
    } catch (err) {
      if (remaining() <= 0) throw timeoutError(opts.timeoutMs)
      throw new PangramError('network', `Could not reach Pangram: ${(err as Error).message}`)
    }
  }

  // Submit, retrying transient failures while the budget allows.
  const submit = async (): Promise<string> => {
    const res = await request('/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, model: opts.model, public_dashboard_link: false })
    })
    if (!res.ok) throw await httpError(res, opts.model)
    const body = (await readJson(res)) as { task_id?: unknown } | null
    if (typeof body?.task_id !== 'string' || !body.task_id) {
      throw new PangramError('bad-response', 'Pangram did not return a task_id.')
    }
    return body.task_id
  }
  let taskId = ''
  for (let attempt = 1; !taskId; attempt++) {
    try {
      taskId = await submit()
    } catch (err) {
      if (!(err instanceof PangramError)) throw err
      if (!isTransient(err) || attempt >= SUBMIT_ATTEMPTS) throw err
      const wait = backoff(attempt)
      if (wait >= remaining()) throw err
      await sleep(wait)
    }
  }

  // Poll until a terminal stage. Transient errors are retried until the deadline.
  let delay = FIRST_POLL_MS
  for (;;) {
    if (delay >= remaining()) throw timeoutError(opts.timeoutMs)
    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.5), MAX_POLL_MS)

    let res: Response
    try {
      res = await request(`/task/${encodeURIComponent(taskId)}`, { method: 'GET' })
    } catch (err) {
      if (err instanceof PangramError && err.kind === 'network') continue
      throw err
    }
    if (!res.ok) {
      const error = await httpError(res, opts.model)
      if (isTransient(error)) continue
      throw error
    }
    const body = (await readJson(res)) as Partial<PangramResult> | null
    const stage = body?.stage
    if (stage === SUCCESS) return validate(body as Partial<PangramResult>)
    if (stage === FAILED) {
      const reason = (typeof body?.headline === 'string' && body.headline) || 'no reason given'
      throw new PangramError('task-failed', `Pangram could not score the text: ${reason}`)
    }
    if (typeof stage !== 'string') {
      throw new PangramError('bad-response', 'Pangram returned a task without a stage.')
    }
  }
}

function isTransient(error: PangramError): boolean {
  return (
    error.kind === 'rate-limited' ||
    error.kind === 'unavailable' ||
    error.kind === 'server' ||
    error.kind === 'network'
  )
}

function backoff(attempt: number): number {
  return 1000 * 2 ** (attempt - 1)
}

function timeoutError(timeoutMs: number): PangramError {
  return new PangramError(
    'timeout',
    `Pangram did not finish scoring within ${Math.round(timeoutMs / 1000)}s.`
  )
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new PangramError('bad-response', `Pangram returned a non-JSON response (${res.status}).`)
  }
}

async function httpError(res: Response, model: string): Promise<PangramError> {
  const detail = await errorDetail(res)
  const suffix = detail ? `: ${detail}` : ''
  const s = res.status
  if (s === 401) return new PangramError('auth', `Pangram rejected the API key (401)${suffix}`, s)
  if (s === 402) return new PangramError('credits', `Pangram account is out of credits (402)`, s)
  if (s === 403) {
    return new PangramError(
      'forbidden',
      `Model "${model}" is not enabled for this Pangram API key (403)${suffix}`,
      s
    )
  }
  if (s === 404) return new PangramError('not-found', `Pangram task not found (404)${suffix}`, s)
  if (s === 422) {
    return new PangramError('invalid', `Pangram rejected the request (422)${suffix}`, s)
  }
  if (s === 429) return new PangramError('rate-limited', `Pangram rate limit hit (429)`, s)
  if (s === 503) {
    return new PangramError('unavailable', `Model "${model}" is temporarily unavailable (503)`, s)
  }
  if (s >= 500) return new PangramError('server', `Pangram server error (${s})${suffix}`, s)
  return new PangramError('client', `Pangram request failed (${s})${suffix}`, s)
}

/** Short, single-line error detail from a Pangram error body. */
async function errorDetail(res: Response): Promise<string> {
  let raw: string
  try {
    raw = await res.text()
  } catch {
    return ''
  }
  let detail: unknown = raw
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; error?: unknown; message?: unknown }
    detail = parsed.detail ?? parsed.error ?? parsed.message ?? raw
  } catch {
    // Not JSON; use the raw text.
  }
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function validate(body: Partial<PangramResult>): PangramResult {
  for (const field of ['fraction_ai', 'fraction_ai_assisted', 'fraction_human'] as const) {
    if (typeof body[field] !== 'number' || !Number.isFinite(body[field])) {
      throw new PangramError('bad-response', `Pangram result is missing ${field}.`)
    }
  }
  return {
    stage: SUCCESS,
    text: str(body.text),
    version: str(body.version),
    headline: str(body.headline),
    prediction: str(body.prediction),
    prediction_short: str(body.prediction_short),
    fraction_ai: body.fraction_ai!,
    fraction_ai_assisted: body.fraction_ai_assisted!,
    fraction_human: body.fraction_human!,
    num_ai_segments: num(body.num_ai_segments),
    num_ai_assisted_segments: num(body.num_ai_assisted_segments),
    num_human_segments: num(body.num_human_segments),
    windows: Array.isArray(body.windows) ? body.windows.filter(isWindow) : []
  }
}

function isWindow(w: unknown): w is PangramWindow {
  return typeof w === 'object' && w !== null && typeof (w as PangramWindow).label === 'string'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

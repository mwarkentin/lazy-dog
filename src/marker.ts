import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ScanResult } from './result.js'

/**
 * The sticky comment ends with a hidden marker holding the cache: the hash of
 * the text that was scored and the result. Anyone can post a comment that
 * looks like ours, so the payload is signed with an HMAC keyed by the Pangram
 * API key; only a verified marker is trusted as a cache.
 */

export interface MarkerData {
  /** SHA-256 of the cleaned text that `result` scored. */
  hash?: string
  /** Model selector used for `result`. */
  model?: string
  result?: ScanResult
}

export interface DecodedMarker {
  data: MarkerData
  /** True when the signature verifies with the current key. */
  trusted: boolean
}

const MARKER = /<!-- lazy-dog:v1 ([A-Za-z0-9_-]*)\.([0-9a-f]*) -->/

export function hasMarker(body: string): boolean {
  return MARKER.test(body)
}

export function encodeMarker(data: MarkerData, secret: string): string {
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url')
  return `<!-- lazy-dog:v1 ${payload}.${secret ? sign(payload, secret) : ''} -->`
}

export function decodeMarker(body: string, secret: string): DecodedMarker | null {
  const m = MARKER.exec(body)
  if (!m) return null
  const [, payload = '', sig = ''] = m
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { data: {}, trusted: false }
  }
  const trusted = Boolean(secret && sig && safeEqual(sig, sign(payload, secret)))
  return { data: trusted ? sanitize(parsed) : {}, trusted }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`lazy-dog:v1:${payload}`).digest('hex').slice(0, 32)
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Keep only well-formed fields, so a stale or odd marker can't break rendering. */
function sanitize(raw: unknown): MarkerData {
  if (typeof raw !== 'object' || raw === null) return {}
  const d = raw as Record<string, unknown>
  const out: MarkerData = {}
  if (typeof d.hash === 'string') out.hash = d.hash
  if (typeof d.model === 'string') out.model = d.model
  const r = d.result as Record<string, unknown> | undefined
  if (
    r &&
    typeof r.fractionAi === 'number' &&
    typeof r.fractionAiAssisted === 'number' &&
    typeof r.fractionHuman === 'number'
  ) {
    const s = (r.segments ?? {}) as Record<string, unknown>
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
    out.result = {
      fractionAi: r.fractionAi,
      fractionAiAssisted: r.fractionAiAssisted,
      fractionHuman: r.fractionHuman,
      prediction: typeof r.prediction === 'string' ? r.prediction : '',
      version: typeof r.version === 'string' ? r.version : '',
      segments: {
        total: n(s.total),
        ai: n(s.ai),
        aiHigh: n(s.aiHigh),
        assisted: n(s.assisted),
        assistedHigh: n(s.assistedHigh)
      },
      quote: typeof r.quote === 'string' ? r.quote : undefined
    }
  }
  return out
}

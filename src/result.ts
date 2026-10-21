import type { Metric } from './config.js'
import type { PangramResult } from './pangram.js'

/** The compact slice of a Pangram result this action reports and caches. */
export interface ScanResult {
  fractionAi: number
  fractionAiAssisted: number
  fractionHuman: number
  /** prediction_short: AI, Human or Mixed. */
  prediction: string
  /** Pangram's model version, e.g. "4.0". */
  version: string
  segments: {
    total: number
    ai: number
    aiHigh: number
    assisted: number
    assistedHigh: number
  }
  /** The most AI-like window, shortened; only ever rendered inside a code span. */
  quote?: string
}

const QUOTE_MAX = 100

export function summarize(r: PangramResult): ScanResult {
  const segments = { total: r.windows.length, ai: 0, aiHigh: 0, assisted: 0, assistedHigh: 0 }
  let best: { score: number; text: string } | undefined
  for (const w of r.windows) {
    const kind = windowKind(w.label)
    const high = String(w.confidence).toLowerCase() === 'high'
    if (kind === 'ai') {
      segments.ai++
      if (high) segments.aiHigh++
    } else if (kind === 'assisted') {
      segments.assisted++
      if (high) segments.assistedHigh++
    }
    const score = typeof w.ai_assistance_score === 'number' ? w.ai_assistance_score : 0
    if (kind !== 'human' && typeof w.text === 'string' && (!best || score > best.score)) {
      best = { score, text: w.text }
    }
  }
  return {
    fractionAi: r.fraction_ai,
    fractionAiAssisted: r.fraction_ai_assisted,
    fractionHuman: r.fraction_human,
    prediction: r.prediction_short,
    version: r.version,
    segments,
    quote: best ? shorten(best.text) : undefined
  }
}

/** Pangram 4 labels are AI-Generated, AI-Assisted and Human Written. */
function windowKind(label: string): 'ai' | 'assisted' | 'human' {
  if (/assist/i.test(label)) return 'assisted'
  if (/\bai\b|generated/i.test(label)) return 'ai'
  return 'human'
}

function shorten(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  if (flat.length <= QUOTE_MAX) return flat
  const cut = flat.slice(0, QUOTE_MAX)
  const space = cut.lastIndexOf(' ')
  return `${space > QUOTE_MAX / 2 ? cut.slice(0, space) : cut}…`
}

export function metricValue(r: ScanResult, metric: Metric): number {
  if (metric === 'fraction_ai') return r.fractionAi
  if (metric === 'fraction_ai_assisted') return r.fractionAiAssisted
  return Math.max(r.fractionAi, r.fractionAiAssisted)
}

export function metricLabel(metric: Metric): string {
  if (metric === 'fraction_ai') return 'AI-generated'
  if (metric === 'fraction_ai_assisted') return 'AI-assisted'
  return 'AI-generated or AI-assisted'
}

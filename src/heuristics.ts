/**
 * Cheap, explainable signals computed before (or instead of) the Pangram call.
 * They are hints for the comment and an optional gate, never a verdict.
 */

export interface DiffStats {
  additions: number
  deletions: number
  changedFiles: number
}

export interface HeuristicSignal {
  id: 'verbose-for-diff' | 'heavy-structure' | 'restates-diff' | 'stock-phrasing' | 'typography'
  weight: number
  fired: boolean
  /** Human-readable explanation, shown in the comment when the signal fires. */
  detail: string
}

export interface HeuristicReport {
  /** Fired weight over total weight, 0-1. */
  score: number
  signals: HeuristicSignal[]
}

const MEDIUM = 2
const LOW = 1

const HEADING = /^#{1,6}\s/
const BULLET = /^(?:[-*+]|\d+[.)])\s+/
const FILE_OR_CODE =
  /`[^`]+`|[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|php|cs|c|h|cpp|ya?ml|json|toml|tf|hcl|md|sh|sql|css|scss|html|lock|cfg|ini|conf|env)\b/i
const EMOJI_LED = /^(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+)?\p{Extended_Pictographic}/u

const STOCK_PHRASES: [label: string, re: RegExp][] = [
  [
    'this PR introduces/adds',
    /\bthis (?:pr|pull request|change) (?:introduces|adds|implements)\b/gi
  ],
  ['comprehensive', /\bcomprehensive(?:ly)?\b/gi],
  ['robust', /\brobust(?:ness)?\b/gi],
  ['seamless', /\bseamless(?:ly)?\b/gi],
  ['ensures that', /\bensur(?:e|es|ing) that\b/gi],
  ['leverage', /\bleverag(?:e|es|ed|ing)\b/gi],
  ['streamline', /\bstreamlin(?:e|es|ed|ing)\b/gi],
  ['delve', /\bdelv(?:e|es|ing)\b/gi],
  ['facilitate', /\bfacilitat(?:e|es|ed|ing)\b/gi],
  ['utilize', /\butiliz(?:e|es|ed|ing)\b/gi],
  ['in summary', /\bin summary\b/gi],
  ['key changes', /\bkey changes\b/gi],
  ['notably', /\bnotably\b/gi],
  ['furthermore', /\bfurthermore\b/gi],
  ['maintainability', /\bmaintainability\b/gi]
]

export function runHeuristics(text: string, wordCount: number, diff: DiffStats): HeuristicReport {
  const lines = text.split('\n')
  const changed = diff.additions + diff.deletions
  const changeLabel = `${changed}-line change`
  const headings = lines.filter((l) => HEADING.test(l)).length
  const bullets = lines.filter((l) => BULLET.test(l))
  const per100 = (n: number): number => (wordCount ? (n * 100) / wordCount : 0)

  const signals: HeuristicSignal[] = []

  signals.push({
    id: 'verbose-for-diff',
    weight: MEDIUM,
    fired: wordCount > 150 && wordCount / Math.max(changed, 1) > 15,
    detail: `${wordCount}-word description for a ${changeLabel}`
  })

  signals.push({
    id: 'heavy-structure',
    weight: MEDIUM,
    fired: changed < 20 && (headings >= 3 || bullets.length >= 10),
    detail: `Heading/bullet structure heavier than the diff warrants (${plural(headings, 'heading')}, ${plural(bullets.length, 'bullet')} for a ${changeLabel})`
  })

  const restating = bullets.filter((b) => FILE_OR_CODE.test(b)).length
  signals.push({
    id: 'restates-diff',
    weight: LOW,
    fired: bullets.length >= 3 && restating / bullets.length > 0.5,
    detail: `Most bullets name files or identifiers, restating the diff (${restating} of ${bullets.length})`
  })

  const found: string[] = []
  let phraseCount = 0
  for (const [label, re] of STOCK_PHRASES) {
    const n = text.match(re)?.length ?? 0
    if (n) {
      found.push(`"${label}"`)
      phraseCount += n
    }
  }
  signals.push({
    id: 'stock-phrasing',
    weight: LOW,
    fired: phraseCount >= 2 && per100(phraseCount) >= 1,
    detail: `Stock phrasing (${found.slice(0, 4).join(', ')}${found.length > 4 ? ', …' : ''})`
  })

  const emDashes = text.match(/\u2014/g)?.length ?? 0
  const emojiLed = lines.filter((l) => EMOJI_LED.test(l)).length
  signals.push({
    id: 'typography',
    weight: LOW,
    fired: (emDashes >= 2 && per100(emDashes) >= 1) || emojiLed >= 2,
    detail: `Typography tells (${plural(emDashes, 'em dash', 'em dashes')}, ${plural(emojiLed, 'emoji-led heading/bullet', 'emoji-led headings/bullets')})`
  })

  const total = signals.reduce((sum, s) => sum + s.weight, 0)
  const fired = signals.filter((s) => s.fired).reduce((sum, s) => sum + s.weight, 0)
  return { score: Math.round((fired / total) * 100) / 100, signals }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

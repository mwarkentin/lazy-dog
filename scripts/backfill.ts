/**
 * Calibration backfill: run recent PRs through the same cleaning, skip rules
 * and heuristics the action uses, and optionally score them with Pangram,
 * then write one CSV row per PR. Use it to pick thresholds and heuristic
 * weights before turning the action on.
 *
 *   GITHUB_TOKEN=... npm run backfill -- getsentry/ops --limit 300 > ops.csv
 *   GITHUB_TOKEN=... PANGRAM_API_KEY=... npm run backfill -- getsentry/ops --limit 300 --pangram > ops.csv
 *
 * Without --pangram nothing leaves GitHub. With it, cleaned PR text is sent to
 * Pangram and costs credits; the cost estimate is printed before any call.
 */
import { getOctokit } from '@actions/github'
import { parseArgs } from 'node:util'
import { cleanBody } from '../src/clean.js'
import { DEFAULT_API_URL, readConfig } from '../src/config.js'
import { detectDisclosure } from '../src/disclosure.js'
import { createGitHubApi } from '../src/github.js'
import { runHeuristics } from '../src/heuristics.js'
import { detect } from '../src/pangram.js'
import { loadTemplateLines } from '../src/repo.js'
import { authorSkip, toPullRequestInfo } from '../src/skip.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: 'string', default: '300' },
    pangram: { type: 'boolean', default: false },
    model: { type: 'string', default: 'pangram-4' },
    'min-words': { type: 'string', default: '50' },
    'max-words': { type: 'string', default: '2000' },
    'skip-authors': { type: 'string', default: '' },
    yes: { type: 'boolean', default: false }
  }
})

const [slug] = positionals
const [owner, repo] = slug?.split('/') ?? []
const token = process.env.GITHUB_TOKEN
if (!owner || !repo || !token) {
  console.error('usage: GITHUB_TOKEN=... backfill <owner/repo> [--limit 300] [--pangram] [--yes]')
  process.exit(2)
}
const apiKey = process.env.PANGRAM_API_KEY ?? ''
if (values.pangram && !apiKey) {
  console.error('--pangram needs PANGRAM_API_KEY')
  process.exit(2)
}

const inputs: Record<string, string> = {
  model: values.model,
  'min-words': values['min-words'],
  'max-words': values['max-words'],
  'skip-authors': values['skip-authors']
}
const cfg = readConfig((name) => inputs[name] ?? '')
const octokit = getOctokit(token)
const api = createGitHubApi(token, owner, repo)
const log = { warning: (m: string) => console.error(`warning: ${m}`) }

const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo })
const template = await loadTemplateLines(api, repoInfo.default_branch, log)
console.error(template ? `Stripping ${template.size} PR template lines.` : 'No PR template found.')

const limit = Number(values.limit)
const listed = []
for await (const page of octokit.paginate.iterator(octokit.rest.pulls.list, {
  owner,
  repo,
  state: 'all',
  sort: 'created',
  direction: 'desc',
  per_page: 100
})) {
  listed.push(...page.data)
  if (listed.length >= limit) break
}

interface Row {
  number: number
  author: string
  created: string
  skip: string
  words: number
  additions: number
  deletions: number
  heuristicScore: number
  signals: string
  disclosed: boolean
  text: string
  fractionAi?: number
  fractionAiAssisted?: number
  fractionHuman?: number
  prediction?: string
  error?: string
}

const rows: Row[] = []
for (const item of listed.slice(0, limit)) {
  // The list endpoint omits diff stats, so fetch each PR.
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: item.number })
  const pr = toPullRequestInfo(data)!
  // Backfilled PRs are mostly closed; judge them as if they were open.
  const skip = authorSkip({ ...pr, state: 'open', draft: false }, cfg)
  const clean = cleanBody(pr.body, {
    templateLines: template,
    stripPatterns: cfg.stripPatterns,
    maxWords: cfg.maxWords
  })
  const heuristics = runHeuristics(clean.full, clean.totalWords, pr)
  rows.push({
    number: pr.number,
    author: pr.authorLogin,
    created: data.created_at,
    skip: skip ?? (clean.totalWords < cfg.minWords ? 'too-short' : ''),
    words: clean.wordCount,
    additions: pr.additions,
    deletions: pr.deletions,
    heuristicScore: heuristics.score,
    signals: heuristics.signals
      .filter((s) => s.fired)
      .map((s) => s.id)
      .join(';'),
    disclosed: detectDisclosure(pr.body).length > 0,
    text: clean.text
  })
}

const eligible = rows.filter((r) => !r.skip)
const units = eligible.reduce((sum, r) => sum + Math.ceil(r.words / 100), 0)
console.error(
  `${rows.length} PRs, ${eligible.length} eligible; ${units} 100-word units ≈ $${(units * 0.05).toFixed(2)} at $0.05/unit.`
)

if (values.pangram) {
  if (!values.yes) {
    console.error('Re-run with --yes to send the eligible descriptions to Pangram.')
    process.exit(1)
  }
  let done = 0
  const queue = [...eligible]
  const worker = async (): Promise<void> => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const r = await detect(row.text, {
          apiKey,
          model: cfg.model,
          baseUrl: process.env.PANGRAM_API_URL ?? DEFAULT_API_URL,
          timeoutMs: 120_000
        })
        row.fractionAi = r.fraction_ai
        row.fractionAiAssisted = r.fraction_ai_assisted
        row.fractionHuman = r.fraction_human
        row.prediction = r.prediction_short
      } catch (err) {
        row.error = (err as Error).message
      }
      console.error(`scored ${++done}/${eligible.length}`)
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
}

const columns = [
  'number',
  'author',
  'created',
  'skip',
  'words',
  'additions',
  'deletions',
  'heuristicScore',
  'signals',
  'disclosed',
  'fractionAi',
  'fractionAiAssisted',
  'fractionHuman',
  'prediction',
  'error'
] as const
const csv = (v: unknown): string => {
  const s = v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
console.log(columns.join(','))
for (const row of rows) console.log(columns.map((c) => csv(row[c])).join(','))

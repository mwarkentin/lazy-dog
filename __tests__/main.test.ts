import { beforeEach, describe, expect, it } from 'vitest'
import type { GitHubApi, IssueComment } from '../src/github.js'
import { run, type Deps } from '../src/main.js'
import { encodeMarker } from '../src/marker.js'
import { PangramError, type PangramResult } from '../src/pangram.js'
import { summarize } from '../src/result.js'
import { toPullRequestInfo } from '../src/skip.js'
import { fixture, SUCCESS } from './helpers.js'

const HUMAN: PangramResult = {
  ...SUCCESS,
  prediction_short: 'Human',
  fraction_ai: 0.04,
  fraction_ai_assisted: 0.02,
  fraction_human: 0.94,
  windows: []
}

/** In-memory GitHub: one PR, its comments, and files on branches. */
class FakeApi implements GitHubApi {
  pr: Record<string, unknown>
  comments: IssueComment[] = []
  files = new Map<string, string>()
  labelActor: string | null = 'label-adder'
  reads: string[] = []
  private nextId = 100

  constructor(pr: Record<string, unknown>) {
    this.pr = pr
  }

  async getPullRequest() {
    return toPullRequestInfo(this.pr)
  }
  async getFile(path: string, ref: string) {
    this.reads.push(`${ref}:${path}`)
    return this.files.get(`${ref}:${path}`) ?? null
  }
  async listDir(path: string, ref: string) {
    const prefix = `${ref}:${path ? `${path}/` : ''}`
    const entries = new Map<string, { name: string; path: string; type: string }>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const [name, ...rest] = key.slice(prefix.length).split('/')
      const full = path ? `${path}/${name}` : name!
      entries.set(name!, { name: name!, path: full, type: rest.length ? 'dir' : 'file' })
    }
    return entries.size ? [...entries.values()] : null
  }
  async listComments() {
    return this.comments
  }
  async createComment(_n: number, body: string) {
    const c = {
      id: this.nextId++,
      body,
      userLogin: 'github-actions[bot]',
      userType: 'Bot',
      htmlUrl: `https://github.com/o/r/pull/7#issuecomment-${this.nextId}`
    }
    this.comments.push(c)
    return c
  }
  async updateComment(id: number, body: string) {
    const c = this.comments.find((x) => x.id === id)!
    c.body = body
    return c
  }
  async findLabelActor() {
    return this.labelActor
  }
}

function prObject(body: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    state: 'open',
    draft: false,
    body,
    user: { login: 'octocat', type: 'User' },
    labels: [],
    additions: 2,
    deletions: 1,
    changed_files: 1,
    base: { ref: 'main', sha: 'b'.repeat(40) },
    head: { sha: 'a'.repeat(40) },
    html_url: 'https://github.com/o/r/pull/7',
    ...over
  }
}

let api: FakeApi
let responses: (PangramResult | Error)[]
let scanned: string[]

beforeEach(() => {
  api = new FakeApi(prObject(fixture('ai.md')))
  responses = []
  scanned = []
})

async function act(
  inputs: Record<string, string> = {},
  payload: Record<string, unknown> = { action: 'opened' }
) {
  const outputs: Record<string, string> = {}
  const failures: string[] = []
  const warnings: string[] = []
  const errors: string[] = []
  const summaries: string[] = []
  const deps: Deps = {
    getInput: (name) =>
      ({ 'pangram-api-key': 'test-key', 'github-token': 'gh-token', ...inputs })[name] ?? '',
    eventName: 'pull_request_target',
    payload: { pull_request: api.pr, ...payload },
    env: {},
    createApi: () => api,
    detect: async (text) => {
      scanned.push(text)
      const next = responses.shift() ?? SUCCESS
      if (next instanceof Error) throw next
      return next
    },
    log: { info: () => {}, warning: (m) => warnings.push(m), error: (m) => errors.push(m) },
    setOutput: (name, value) => (outputs[name] = value),
    setFailed: (m) => failures.push(m),
    setSecret: () => {},
    writeSummary: async (m) => void summaries.push(m)
  }
  const outcome = await run(deps)
  return { outcome, outputs, failures, warnings, errors, summaries }
}

describe('run', () => {
  it('scores a PR, comments once, and only warns in warn mode', async () => {
    const r = await act()
    expect(scanned).toHaveLength(1)
    expect(r.outcome?.state).toBe('flagged')
    expect(r.failures).toEqual([])
    expect(api.comments).toHaveLength(1)
    expect(api.comments[0]!.body).toMatch(/^### AI description check: flagged/)
    expect(r.outputs).toMatchObject({
      skipped: 'false',
      verdict: 'flag',
      'fraction-ai': '0.78',
      prediction: 'AI',
      'model-version': '4.0',
      cached: 'false',
      disclosed: 'true',
      'heuristic-score': '1.00'
    })
    expect(r.outputs['comment-url']).toMatch(/issuecomment/)
    expect(r.summaries[0]).toContain('<details><summary>Details</summary>')
  })

  it('fails with a one-line message pointing at the comment in fail mode', async () => {
    const r = await act({ mode: 'fail' })
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]).toMatch(
      /^Pangram estimates 78% of this PR description is AI-generated \(threshold 50%\)\. See https:\/\/github\.com\/o\/r\/pull\/7#issuecomment-\d+ for details/
    )
    expect(r.failures[0]).not.toContain('\n')
  })

  it('reuses the cached score when the text is unchanged (title-only edit)', async () => {
    await act({ mode: 'fail' })
    const r = await act({ mode: 'fail' }, { action: 'edited', changes: { title: { from: 'x' } } })
    expect(scanned).toHaveLength(1)
    expect(r.outputs.cached).toBe('true')
    expect(r.outcome?.state).toBe('flagged')
    expect(r.failures).toHaveLength(1)
    expect(api.comments).toHaveLength(1)
  })

  it('rescans when the model changes', async () => {
    await act()
    await act({ model: 'pangram-5' }, { action: 'edited', changes: { body: { from: '' } } })
    expect(scanned).toHaveLength(2)
  })

  it('passes and edits the same comment when a flagged PR is rewritten', async () => {
    await act({ mode: 'fail' })
    api.pr = prObject(fixture('human.md'))
    responses.push(HUMAN)
    const r = await act({ mode: 'fail' }, { action: 'edited', changes: { body: { from: '' } } })
    expect(scanned).toHaveLength(2)
    expect(r.outcome?.state).toBe('passed')
    expect(r.failures).toEqual([])
    expect(api.comments).toHaveLength(1)
    expect(api.comments[0]!.body).toMatch(/^### AI description check: passed/)
  })

  it('bypasses via the label without a new API call, naming who added it', async () => {
    await act({ mode: 'fail' })
    api.pr = { ...api.pr, labels: [{ name: 'skip-ai-check' }] }
    const r = await act(
      { mode: 'fail' },
      { action: 'labeled', label: { name: 'skip-ai-check' }, sender: { login: 'maintainer' } }
    )
    expect(scanned).toHaveLength(1)
    expect(r.failures).toEqual([])
    expect(r.outcome?.state).toBe('bypassed')
    expect(r.outputs).toMatchObject({
      bypassed: 'true',
      'bypassed-by': 'maintainer',
      verdict: 'flag',
      cached: 'true'
    })
    expect(api.comments[0]!.body).toContain('Bypassed via the `skip-ai-check` label by @maintainer')

    // Removing the label re-evaluates, still from the cache.
    api.pr = { ...api.pr, labels: [] }
    const after = await act(
      { mode: 'fail' },
      { action: 'unlabeled', label: { name: 'skip-ai-check' } }
    )
    expect(scanned).toHaveLength(1)
    expect(after.outcome?.state).toBe('flagged')
    expect(after.failures).toHaveLength(1)
  })

  it('looks up the bypasser from the timeline on other events', async () => {
    api.pr = { ...api.pr, labels: [{ name: 'skip-ai-check' }] }
    const r = await act({ mode: 'fail' }, { action: 'edited', changes: { body: { from: '' } } })
    expect(r.outputs['bypassed-by']).toBe('label-adder')
  })

  it('can skip the scan entirely when the bypass label is already on', async () => {
    api.pr = { ...api.pr, labels: [{ name: 'Skip-AI-Check' }] }
    const r = await act({ mode: 'fail', 'bypass-label-skip-scan': 'true' })
    expect(scanned).toEqual([])
    expect(r.outcome?.state).toBe('bypassed')
    expect(r.outputs).toMatchObject({ skipped: 'true', 'skip-reason': 'bypass-label' })
    expect(api.comments[0]!.body).toContain('The description was not scored.')
  })

  it.each([
    ['draft', { draft: true }],
    ['bot', { user: { login: 'renovate[bot]', type: 'Bot' } }],
    ['closed', { state: 'closed' }]
  ])('skips %s PRs without scanning or commenting', async (reason, over) => {
    api.pr = { ...api.pr, ...over }
    const r = await act({ mode: 'fail' })
    expect(scanned).toEqual([])
    expect(api.comments).toEqual([])
    expect(r.outputs).toMatchObject({ skipped: 'true', 'skip-reason': reason, verdict: '' })
    expect(r.failures).toEqual([])
  })

  it('skips allow-listed authors case-insensitively', async () => {
    const r = await act({ 'skip-authors': 'OctoCat' })
    expect(r.outputs['skip-reason']).toBe('skip-author')
  })

  it('turns an existing flagged comment into a skip note when a PR goes back to draft', async () => {
    await act()
    api.pr = { ...api.pr, draft: true }
    await act({}, { action: 'converted_to_draft' })
    expect(api.comments).toHaveLength(1)
    expect(api.comments[0]!.body).toMatch(/^### AI description check: skipped\n\nDraft/)
    // The cache survives, so marking it ready again costs nothing.
    api.pr = { ...api.pr, draft: false }
    await act({}, { action: 'ready_for_review' })
    expect(scanned).toHaveLength(1)
  })

  it('skips short descriptions after stripping the base-branch PR template', async () => {
    api.files.set('main:.github/PULL_REQUEST_TEMPLATE.md', fixture('pull_request_template.md'))
    api.pr = prObject(fixture('template-only.md') + '\nTypo fix.')
    const r = await act()
    expect(r.outputs).toMatchObject({ 'skip-reason': 'too-short', 'word-count': '2' })
    expect(api.reads).toContain('main:.github/PULL_REQUEST_TEMPLATE.md')
    expect(scanned).toEqual([])
  })

  it('reads every template in a PULL_REQUEST_TEMPLATE directory', async () => {
    api.files.set('main:docs/pull_request_template/bug.md', '## Bug summary')
    api.files.set('main:docs/pull_request_template/feature.md', '## Feature summary')
    api.pr = prObject(`## Bug summary\n## Feature summary\n${fixture('human.md')}`)
    await act()
    expect(scanned[0]).not.toMatch(/Bug summary|Feature summary/)
  })

  it('skips cleanly when the API key is missing (fork PRs)', async () => {
    const r = await act({ 'pangram-api-key': '', mode: 'fail' })
    expect(r.outputs).toMatchObject({ skipped: 'true', 'skip-reason': 'no-api-key' })
    expect(r.failures).toEqual([])
    expect(api.comments).toEqual([])
  })

  it('treats API errors as infra failures governed by fail-on-error', async () => {
    responses.push(new PangramError('credits', 'Pangram account is out of credits (402)', 402))
    const lenient = await act({ mode: 'fail' })
    expect(lenient.failures).toEqual([])
    expect(lenient.outputs).toMatchObject({ skipped: 'true', 'skip-reason': 'api-error' })
    expect(lenient.warnings.join()).toContain('out of credits')

    responses.push(new PangramError('credits', 'Pangram account is out of credits (402)', 402))
    const strict = await act({ mode: 'fail', 'fail-on-error': 'true' })
    expect(strict.failures).toEqual(['Pangram API error: Pangram account is out of credits (402)'])
  })

  it('reports config errors from Pangram as errors even when not failing', async () => {
    responses.push(new PangramError('auth', 'Pangram rejected the API key (401)', 401))
    const r = await act()
    expect(r.failures).toEqual([])
    expect(r.errors.join()).toContain('401')
  })

  it('ignores a forged cache comment posted by the PR author', async () => {
    const forged = encodeMarker(
      { hash: 'x', model: 'pangram-4', result: summarize(HUMAN) },
      'guessed-key'
    )
    api.comments.push({
      id: 1,
      body: forged,
      userLogin: 'octocat',
      userType: 'User',
      htmlUrl: 'https://github.com/o/r/pull/7#issuecomment-1'
    })
    const r = await act({ mode: 'fail' })
    expect(scanned).toHaveLength(1)
    expect(r.outcome?.state).toBe('flagged')
    expect(api.comments).toHaveLength(2)
  })

  it('on-flag comments only once flagged, then keeps the comment current', async () => {
    responses.push(HUMAN)
    api.pr = prObject(fixture('human.md'))
    await act({ comment: 'on-flag' })
    expect(api.comments).toEqual([])

    api.pr = prObject(fixture('ai.md'))
    await act({ comment: 'on-flag' }, { action: 'edited', changes: { body: { from: '' } } })
    expect(api.comments).toHaveLength(1)

    responses.push(HUMAN)
    api.pr = prObject(`${fixture('human.md')}\nOne more human sentence.`)
    await act({ comment: 'on-flag' }, { action: 'edited', changes: { body: { from: '' } } })
    expect(api.comments[0]!.body).toMatch(/passed/)
  })

  it('comment: false never touches comments', async () => {
    await act({ comment: 'false' })
    expect(api.comments).toEqual([])
  })

  it('loads failure-message-file from the base branch, never the head', async () => {
    api.files.set('main:.github/ai-check/failure.md', 'Custom: {{score}} — use `{{bypass_label}}`.')
    const r = await act({ 'failure-message-file': './.github/ai-check/failure.md' })
    expect(api.reads).toContain('main:.github/ai-check/failure.md')
    expect(api.comments[0]!.body).toMatch(/^Custom: 78% — use `skip-ai-check`\./)
    expect(r.warnings).toEqual([])
  })

  it('scan-on reuses the last score on other events', async () => {
    await act({ 'scan-on': 'opened' })
    api.pr = prObject(`${fixture('ai.md')}\nExtra line.`)
    const r = await act(
      { 'scan-on': 'opened' },
      { action: 'edited', changes: { body: { from: '' } } }
    )
    expect(scanned).toHaveLength(1)
    expect(r.outputs.cached).toBe('true')
    expect(api.comments[0]!.body).toContain('only scans on `opened`')
  })

  it('scan-on skips when nothing was scored yet', async () => {
    const r = await act({ 'scan-on': 'opened' }, { action: 'synchronize' })
    expect(r.outputs['skip-reason']).toBe('not-scanned-on-event')
  })

  it('gate mode only calls Pangram when heuristics cross the threshold', async () => {
    // Template headings would otherwise count as structure.
    api.files.set('main:.github/pull_request_template.md', fixture('pull_request_template.md'))
    api.pr = prObject(fixture('human.md'))
    const quiet = await act({ heuristics: 'gate' })
    expect(quiet.outputs['skip-reason']).toBe('below-heuristic-threshold')
    expect(scanned).toEqual([])

    api.pr = prObject(fixture('ai.md'))
    await act({ heuristics: 'gate' })
    expect(scanned).toHaveLength(1)
  })

  it('skip-if-disclosed skips disclosed descriptions', async () => {
    const r = await act({ 'skip-if-disclosed': 'true' })
    expect(r.outputs).toMatchObject({ 'skip-reason': 'disclosed', disclosed: 'true' })
    expect(scanned).toEqual([])
  })

  it('fails the step on invalid configuration', async () => {
    const r = await act({ threshold: 'high' })
    expect(r.failures).toEqual([expect.stringContaining('threshold')])
    expect(r.outcome).toBeUndefined()
  })

  it('skips non-PR events', async () => {
    const outputs: Record<string, string> = {}
    const outcome = await run({
      getInput: (n) => (n === 'pangram-api-key' ? 'k' : ''),
      eventName: 'push',
      payload: {},
      env: {},
      createApi: () => api,
      detect: async () => SUCCESS,
      log: { info: () => {}, warning: () => {}, error: () => {} },
      setOutput: (n, v) => (outputs[n] = v),
      setFailed: () => {},
      setSecret: () => {},
      writeSummary: async () => {}
    })
    expect(outcome?.state).toBe('skipped')
    expect(outputs['skip-reason']).toBe('not-a-pull-request')
  })
})

// Runs the built bundle (dist/index.js) end to end against a local mock of the
// Pangram and GitHub REST APIs, the way the Actions runner would invoke it.
//   npm run build && npm run smoke
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const body = readFileSync(new URL('../__tests__/fixtures/ai.md', import.meta.url), 'utf8')
const pr = {
  number: 7,
  state: 'open',
  draft: false,
  body,
  user: { login: 'octocat', type: 'User' },
  labels: [],
  additions: 2,
  deletions: 1,
  changed_files: 1,
  base: { ref: 'main' },
  head: { sha: 'a'.repeat(40) },
  html_url: 'https://github.com/o/r/pull/7'
}
const result = {
  stage: 'STAGE_SUCCESS',
  text: body,
  version: '4.0',
  headline: 'AI Detected',
  prediction: 'We believe that this text is AI-generated.',
  prediction_short: 'AI',
  fraction_ai: 0.81,
  fraction_ai_assisted: 0.04,
  fraction_human: 0.15,
  num_ai_segments: 2,
  num_ai_assisted_segments: 0,
  num_human_segments: 1,
  windows: [
    {
      text: 'This PR introduces a comprehensive update.',
      label: 'AI-Generated',
      ai_assistance_score: 0.97,
      confidence: 'High',
      start_index: 0,
      end_index: 42,
      word_count: 6
    }
  ]
}

const comments = []
const pangramCalls = []
let polls = 0

const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const url = new URL(req.url, 'http://localhost')
  const send = (status, json) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(json))
  }
  const route = `${req.method} ${url.pathname}`

  if (route === 'POST /pangram/task') {
    assert.equal(req.headers['x-api-key'], 'smoke-key')
    pangramCalls.push(JSON.parse(raw))
    return send(200, { task_id: 'task-1' })
  }
  if (route === 'GET /pangram/task/task-1') {
    return send(200, polls++ === 0 ? { task_id: 'task-1', stage: 'STAGE_PREPROCESSING' } : result)
  }
  if (route === 'GET /repos/o/r/pulls/7') return send(200, pr)
  if (url.pathname.startsWith('/repos/o/r/contents')) return send(404, { message: 'Not Found' })
  if (route === 'GET /repos/o/r/issues/7/comments') return send(200, comments)
  if (route === 'POST /repos/o/r/issues/7/comments') {
    const comment = {
      id: comments.length + 1,
      body: JSON.parse(raw).body,
      user: { login: 'github-actions[bot]', type: 'Bot' },
      html_url: `https://github.com/o/r/pull/7#issuecomment-${comments.length + 1}`
    }
    comments.push(comment)
    return send(201, comment)
  }
  const patch = /^PATCH \/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(route)
  if (patch) {
    const comment = comments.find((c) => c.id === Number(patch[1]))
    comment.body = JSON.parse(raw).body
    return send(200, comment)
  }
  send(404, { message: `unexpected ${route}` })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const dir = mkdtempSync(join(tmpdir(), 'lazy-dog-smoke-'))

async function runAction(event, inputs) {
  const eventPath = join(dir, 'event.json')
  const outputPath = join(dir, `output-${Math.random()}`)
  const summaryPath = join(dir, `summary-${Math.random()}`)
  writeFileSync(eventPath, JSON.stringify({ ...event, pull_request: pr }))
  writeFileSync(outputPath, '')
  writeFileSync(summaryPath, '')
  const env = {
    PATH: process.env.PATH,
    GITHUB_EVENT_NAME: 'pull_request_target',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_API_URL: base,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    NO_PROXY: '127.0.0.1,localhost',
    'INPUT_PANGRAM-API-KEY': 'smoke-key',
    'INPUT_PANGRAM-API-URL': `${base}/pangram`,
    'INPUT_GITHUB-TOKEN': 'gh-token',
    INPUT_MODE: 'fail'
  }
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v
  // Async spawn: the mock server lives in this process and must keep serving.
  const child = spawn(process.execPath, [new URL('../dist/index.js', import.meta.url).pathname], {
    env
  })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stdout += d))
  const status = await new Promise((resolve) => child.on('close', resolve))
  const outputs = {}
  for (const m of readFileSync(outputPath, 'utf8').matchAll(/^(.+?)<<(.+)\n([\s\S]*?)\n\2$/gm)) {
    outputs[m[1]] = m[3]
  }
  return { status, stdout, outputs, summary: readFileSync(summaryPath, 'utf8') }
}

try {
  const first = await runAction({ action: 'opened' }, {})
  assert.equal(first.status, 1, `expected a failing exit in fail mode:\n${first.stdout}`)
  assert.match(
    first.stdout,
    /::error::Pangram estimates 81%25 of this PR description is AI-generated/
  )
  assert.equal(first.outputs.verdict, 'flag')
  assert.equal(first.outputs.cached, 'false')
  assert.equal(pangramCalls.length, 1)
  assert.equal(pangramCalls[0].model, 'pangram-4')
  assert.equal(pangramCalls[0].public_dashboard_link, false)
  assert.equal(comments.length, 1)
  assert.match(comments[0].body, /^### AI description check: flagged/)
  assert.match(comments[0].body, /<!-- lazy-dog:v1 /)
  assert.match(first.summary, /<details><summary>Details<\/summary>/)

  const second = await runAction({ action: 'edited', changes: { title: { from: 'old' } } }, {})
  assert.equal(second.status, 1)
  assert.equal(second.outputs.cached, 'true')
  assert.equal(pangramCalls.length, 1, 'a title-only edit must not call Pangram')
  assert.equal(comments.length, 1, 'the sticky comment is edited, not duplicated')

  pr.labels = [{ name: 'skip-ai-check' }]
  const third = await runAction(
    { action: 'labeled', label: { name: 'skip-ai-check' }, sender: { login: 'maintainer' } },
    {}
  )
  assert.equal(third.status, 0, third.stdout)
  assert.equal(third.outputs.bypassed, 'true')
  assert.equal(third.outputs['bypassed-by'], 'maintainer')
  assert.match(comments[0].body, /Bypassed via the `skip-ai-check` label by @maintainer/)

  console.log('smoke: ok (flag, cached re-run, bypass)')
} finally {
  server.close()
}

import { describe, expect, it } from 'vitest'
import { detect, PangramError, type DetectOptions } from '../src/pangram.js'
import { SUCCESS } from './helpers.js'

type Reply = { status: number; body?: unknown } | Error

/** A scripted fetch plus a fake clock that only advances when the client sleeps. */
function harness(replies: Reply[], timeoutMs = 60000) {
  const calls: { url: string; init: RequestInit }[] = []
  let clock = 0
  const opts: DetectOptions = {
    apiKey: 'test-key',
    model: 'pangram-4',
    baseUrl: 'https://pangram.test',
    timeoutMs,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const reply = replies.shift() ?? { status: 200, body: { stage: 'STAGE_PREPROCESSING' } }
      if (reply instanceof Error) throw reply
      return new Response(
        typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}),
        { status: reply.status }
      )
    }) as typeof fetch
  }
  return { opts, calls, elapsed: () => clock }
}

describe('detect', () => {
  it('submits the text with an explicit model and polls to success', async () => {
    const h = harness([
      { status: 200, body: { task_id: 'task-1' } },
      { status: 200, body: { task_id: 'task-1', stage: 'STAGE_PREPROCESSING' } },
      { status: 200, body: SUCCESS }
    ])
    const result = await detect('hello world', h.opts)
    expect(result.fraction_ai).toBe(0.78)
    expect(result.windows).toHaveLength(3)

    const [submit, poll] = h.calls
    expect(submit!.url).toBe('https://pangram.test/task')
    expect(submit!.init.method).toBe('POST')
    expect((submit!.init.headers as Record<string, string>)['x-api-key']).toBe('test-key')
    expect(JSON.parse(submit!.init.body as string)).toEqual({
      text: 'hello world',
      model: 'pangram-4',
      public_dashboard_link: false
    })
    expect(poll!.url).toBe('https://pangram.test/task/task-1')
    expect(h.calls).toHaveLength(3)
  })

  it('reports STAGE_FAILED with the headline', async () => {
    const h = harness([
      { status: 200, body: { task_id: 't' } },
      { status: 200, body: { stage: 'STAGE_FAILED', headline: 'preprocessing: no valid text' } }
    ])
    await expect(detect('x', h.opts)).rejects.toMatchObject({
      kind: 'task-failed',
      message: expect.stringContaining('preprocessing: no valid text')
    })
  })

  it.each([
    [401, 'auth', true],
    [402, 'credits', false],
    [403, 'forbidden', true],
    [422, 'invalid', true]
  ] as const)('maps HTTP %i to %s without retrying', async (status, kind, isConfig) => {
    const h = harness([{ status, body: { detail: 'nope' } }])
    const err = await detect('x', h.opts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PangramError)
    expect(err).toMatchObject({ kind, status })
    expect((err as PangramError).isConfigError).toBe(isConfig)
    expect(h.calls).toHaveLength(1)
  })

  it('retries a rate-limited submit', async () => {
    const h = harness([
      { status: 429 },
      { status: 200, body: { task_id: 't' } },
      { status: 200, body: SUCCESS }
    ])
    await expect(detect('x', h.opts)).resolves.toMatchObject({ prediction_short: 'AI' })
    expect(h.calls).toHaveLength(3)
  })

  it('gives up on a model that stays unavailable', async () => {
    const h = harness([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }])
    await expect(detect('x', h.opts)).rejects.toMatchObject({ kind: 'unavailable', status: 503 })
    expect(h.calls).toHaveLength(3)
  })

  it('treats network errors on submit as transient', async () => {
    const h = harness([
      new TypeError('fetch failed'),
      { status: 200, body: { task_id: 't' } },
      { status: 200, body: SUCCESS }
    ])
    await expect(detect('x', h.opts)).resolves.toMatchObject({ fraction_ai: 0.78 })
  })

  it('keeps polling through transient poll errors', async () => {
    const h = harness([
      { status: 200, body: { task_id: 't' } },
      { status: 502 },
      new TypeError('socket hang up'),
      { status: 200, body: SUCCESS }
    ])
    await expect(detect('x', h.opts)).resolves.toMatchObject({ fraction_ai: 0.78 })
  })

  it('times out when the task never finishes', async () => {
    const h = harness([{ status: 200, body: { task_id: 't' } }], 10000)
    await expect(detect('x', h.opts)).rejects.toMatchObject({ kind: 'timeout' })
    expect(h.elapsed()).toBeLessThanOrEqual(10000)
  })

  it('rejects a success without scores', async () => {
    const h = harness([
      { status: 200, body: { task_id: 't' } },
      { status: 200, body: { stage: 'STAGE_SUCCESS' } }
    ])
    await expect(detect('x', h.opts)).rejects.toMatchObject({ kind: 'bad-response' })
  })

  it('rejects a submit without a task_id', async () => {
    const h = harness([{ status: 200, body: {} }])
    await expect(detect('x', h.opts)).rejects.toMatchObject({ kind: 'bad-response' })
  })
})

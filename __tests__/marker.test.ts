import { describe, expect, it } from 'vitest'
import type { IssueComment } from '../src/github.js'
import { decodeMarker, encodeMarker, type MarkerData } from '../src/marker.js'
import { findSticky } from '../src/report.js'
import { summarize } from '../src/result.js'
import { SUCCESS } from './helpers.js'

const data: MarkerData = { hash: 'a'.repeat(64), model: 'pangram-4', result: summarize(SUCCESS) }

const comment = (
  id: number,
  body: string,
  userType = 'Bot',
  userLogin = 'github-actions[bot]'
): IssueComment => ({
  id,
  body,
  userLogin,
  userType,
  htmlUrl: `https://github.com/o/r/pull/1#issuecomment-${id}`
})

describe('marker', () => {
  it('round-trips signed data', () => {
    const decoded = decodeMarker(`Hello\n\n${encodeMarker(data, 'key')}`, 'key')
    expect(decoded).toEqual({ data, trusted: true })
  })

  it('does not trust a marker signed with another key', () => {
    expect(decodeMarker(encodeMarker(data, 'old-key'), 'new-key')).toEqual({
      data: {},
      trusted: false
    })
  })

  it('does not trust a tampered payload', () => {
    const marker = encodeMarker(data, 'key')
    const forged = encodeMarker({ ...data, result: { ...data.result!, fractionAi: 0 } }, 'key')
    const tampered = forged.replace(/\.[0-9a-f]+ -->/, marker.match(/\.[0-9a-f]+ -->/)![0])
    expect(decodeMarker(tampered, 'key')?.trusted).toBe(false)
  })

  it('never puts raw text in the comment body', () => {
    const marker = encodeMarker(
      { ...data, result: { ...data.result!, quote: '--> <script>' } },
      'k'
    )
    expect(marker).toMatch(/^<!-- lazy-dog:v1 [A-Za-z0-9_-]+\.[0-9a-f]{32} -->$/)
  })
})

describe('findSticky', () => {
  it('ignores forged markers posted by people', () => {
    const forged = comment(1, encodeMarker(data, 'guessed-key'), 'User', 'mallory')
    expect(findSticky([forged], 'key')).toBeNull()
  })

  it('prefers the comment whose signature verifies', () => {
    const stale = comment(1, encodeMarker(data, 'old-key'))
    const ours = comment(2, encodeMarker(data, 'key'))
    expect(findSticky([stale, ours], 'key')).toMatchObject({ comment: { id: 2 }, trusted: true })
  })

  it("falls back to a bot's marker comment but trusts none of its data", () => {
    const stale = comment(1, encodeMarker(data, 'old-key'))
    expect(findSticky([stale], 'key')).toEqual({ comment: stale, data: {}, trusted: false })
  })
})

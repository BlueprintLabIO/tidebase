import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { consumeChallengePg, rateLimitPg, sweepAbuseStores } from '../src/ratelimit'

describe('PG-backed rate limiter (multi-replica)', () => {
  it('allows up to the limit then blocks within a window', async () => {
    const bucket = `test:${randomBytes(6).toString('hex')}`
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) results.push(await rateLimitPg(bucket, 3, 60_000))
    expect(results).toEqual([true, true, true, false, false])
  })

  it('resets at a window boundary', async () => {
    const bucket = `test:${randomBytes(6).toString('hex')}`
    const t0 = new Date('2030-01-01T00:00:00Z')
    expect(await rateLimitPg(bucket, 1, 60_000, t0)).toBe(true)
    expect(await rateLimitPg(bucket, 1, 60_000, t0)).toBe(false)
    const t1 = new Date(t0.getTime() + 61_000) // next window
    expect(await rateLimitPg(bucket, 1, 60_000, t1)).toBe(true)
  })
})

describe('PG-backed challenge replay cache', () => {
  it('accepts first use and rejects replay', async () => {
    const hash = randomBytes(16).toString('hex')
    expect(await consumeChallengePg(hash, new Date(Date.now() + 90_000))).toBe(true)
    expect(await consumeChallengePg(hash, new Date(Date.now() + 90_000))).toBe(false)
  })

  it('sweep removes expired challenges so the table does not grow unbounded', async () => {
    const hash = randomBytes(16).toString('hex')
    await consumeChallengePg(hash, new Date(Date.now() - 1000)) // already expired
    await sweepAbuseStores(new Date())
    // after sweep the hash is gone, so it can be consumed fresh again
    expect(await consumeChallengePg(hash, new Date(Date.now() + 90_000))).toBe(true)
  })
})

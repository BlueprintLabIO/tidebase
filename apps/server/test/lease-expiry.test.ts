import { describe, expect, it } from 'vitest'
import { api, createRun, sleep } from './helpers'

// Lease duration is read at module load, so it must be set before importing the app.
process.env.TIDEBASE_LEASE_MS = '250'
const { createApp } = await import('../src/app')

const app = createApp()

describe('lease expiry and takeover', () => {
  it('another worker can take over a step once the lease expires', async () => {
    const run = await createRun(app)
    const first = await api(app, 'POST', `/runs/${run.id}/steps/begin`, {
      name: 'crashable',
      inputHash: 'h1',
      leaseOwner: 'w1'
    })
    expect(first.body.action).toBe('execute')

    await sleep(400)

    const takeover = await api(app, 'POST', `/runs/${run.id}/steps/begin`, {
      name: 'crashable',
      inputHash: 'h1',
      leaseOwner: 'w2'
    })
    expect(takeover.body.action).toBe('execute')
    expect(takeover.body.step.leaseOwner).toBe('w2')
    expect(takeover.body.step.attempt).toBe(2)
  })

  it('the original worker is fenced out after a takeover', async () => {
    const run = await createRun(app)
    const first = await api(app, 'POST', `/runs/${run.id}/steps/begin`, {
      name: 'zombie',
      inputHash: 'h1',
      leaseOwner: 'w1'
    })
    await sleep(400)
    await api(app, 'POST', `/runs/${run.id}/steps/begin`, {
      name: 'zombie',
      inputHash: 'h1',
      leaseOwner: 'w2'
    })

    // The zombie worker wakes up and tries to report its stale result.
    const staleComplete = await api(
      app,
      'POST',
      `/runs/${run.id}/steps/${first.body.step.id}/complete`,
      { leaseOwner: 'w1', output: 'stale' }
    )
    expect(staleComplete.status).toBe(409)
  })

  it('an expired run lease can be reclaimed by a new worker', async () => {
    const run = await createRun(app)
    const first = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w1'
    })
    expect(first.status).toBe(200)

    await sleep(400)

    const second = await api(app, 'POST', `/runs/${run.id}/begin`, undefined, {
      'x-tidebase-worker': 'w2'
    })
    expect(second.status).toBe(200)
    expect(second.body.run.leaseOwner).toBe('w2')
    expect(second.body.run.attempt).toBe(2)
  })
})

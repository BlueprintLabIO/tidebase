import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { api, createRun } from './helpers'

// Invariant: when TIDEBASE_API_KEY is configured, every endpoint except
// /health rejects requests that don't present the key; when it is not
// configured, behavior is unchanged (open, for trusted local setups).

describe('API auth (opt-in shared token)', () => {
  const KEY = 'test-secret-key'

  it('leaves the API open when no key is configured', async () => {
    const app = createApp({ apiKey: undefined })
    const run = await createRun(app)
    expect(run.id).toMatch(/^run_/)
  })

  it('rejects unauthenticated requests on every mutating and read surface', async () => {
    const app = createApp({ apiKey: KEY })
    const surfaces: Array<[string, string]> = [
      ['POST', '/runs/some-workflow'],
      ['GET', '/runs'],
      ['GET', '/runs/run_x'],
      ['POST', '/runs/run_x/begin'],
      ['POST', '/runs/run_x/steps/begin'],
      ['PUT', '/runs/run_x/state'],
      ['POST', '/runs/run_x/gates/begin'],
      ['POST', '/runs/run_x/usage']
    ]
    for (const [method, path] of surfaces) {
      const res = await api(app, method, path, method === 'GET' ? undefined : {})
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('rejects a wrong key and a malformed authorization header', async () => {
    const app = createApp({ apiKey: KEY })
    const wrong = await api(app, 'GET', '/runs', undefined, {
      authorization: 'Bearer not-the-key'
    })
    expect(wrong.status).toBe(401)

    const malformed = await api(app, 'GET', '/runs', undefined, {
      authorization: KEY // missing Bearer prefix
    })
    expect(malformed.status).toBe(401)
  })

  it('accepts the correct bearer key end to end (create, step, complete)', async () => {
    const app = createApp({ apiKey: KEY })
    const auth = { authorization: `Bearer ${KEY}` }

    const created = await api(app, 'POST', '/runs/auth-workflow', {}, auth)
    expect(created.status).toBe(200)
    const runId = created.body.run.id

    const begin = await api(
      app,
      'POST',
      `/runs/${runId}/steps/begin`,
      { name: 's1', inputHash: 'h1', input: null, leaseOwner: 'w1' },
      auth
    )
    expect(begin.status).toBe(200)
    expect(begin.body.action).toBe('execute')

    const complete = await api(
      app,
      'POST',
      `/runs/${runId}/steps/${begin.body.step.id}/complete`,
      { leaseOwner: 'w1', output: 1 },
      auth
    )
    expect(complete.status).toBe(200)
  })

  it('keeps /health open for probes even with auth enabled', async () => {
    const app = createApp({ apiKey: KEY })
    const res = await api(app, 'GET', '/health')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('accepts the key as ?token= on the SSE endpoint only', async () => {
    const app = createApp({ apiKey: KEY })
    const auth = { authorization: `Bearer ${KEY}` }
    const created = await api(app, 'POST', '/runs/auth-sse', {}, auth)
    const runId = created.body.run.id

    // token on a non-SSE endpoint must NOT bypass auth
    const list = await api(app, 'GET', `/runs?token=${KEY}`)
    expect(list.status).toBe(401)

    // token on the event stream is accepted (EventSource cannot set headers)
    const sse = await app.request(`/runs/${runId}/events?token=${KEY}`, {
      method: 'GET'
    })
    expect(sse.status).toBe(200)
    await sse.body?.cancel()

    const sseDenied = await app.request(`/runs/${runId}/events`, { method: 'GET' })
    expect(sseDenied.status).toBe(401)
  })
})

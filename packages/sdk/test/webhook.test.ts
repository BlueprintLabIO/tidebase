import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { Tidebase } from '../src/index'

const SECRET = 'sek-123'

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function post(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/tidebase/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body
  })
}

const resumePayload = JSON.stringify({
  type: 'run.resume',
  runId: 'run_abc',
  workflowName: 'not-registered',
  reason: 'test'
})

describe('webhook signature verification', () => {
  let handler: (request: Request) => Promise<Response>

  beforeEach(() => {
    // Ensure the SDK does not pick up secrets from the surrounding shell.
    delete process.env.TIDEBASE_WEBHOOK_SECRET
    delete process.env.TIDEBASE_URL
    delete process.env.TIDEBASE_API_KEY
    const tide = new Tidebase({ url: 'http://127.0.0.1:9', webhookSecret: SECRET })
    handler = tide.webhook()
  })

  it('rejects non-POST requests', async () => {
    const response = await handler(new Request('http://localhost/x', { method: 'GET' }))
    expect(response.status).toBe(405)
  })

  it('rejects an unsigned request when a secret is configured', async () => {
    const response = await handler(post(resumePayload))
    expect(response.status).toBe(401)
  })

  it('rejects a wrong signature', async () => {
    const response = await handler(
      post(resumePayload, { 'x-tidebase-signature': sign(resumePayload, 'wrong-secret') })
    )
    expect(response.status).toBe(401)
  })

  it('rejects a valid signature over a tampered body', async () => {
    const tampered = resumePayload.replace('run_abc', 'run_evil')
    const response = await handler(
      post(tampered, { 'x-tidebase-signature': sign(resumePayload) })
    )
    expect(response.status).toBe(401)
  })

  it('rejects malformed signature headers without throwing', async () => {
    for (const header of ['', 'md5=abc', 'sha256=', 'sha256=zz-not-hex', 'sha256=abcd']) {
      const response = await handler(
        post(resumePayload, { 'x-tidebase-signature': header })
      )
      expect(response.status).toBe(401)
    }
  })

  it('accepts a valid signature (and then 404s on the unknown workflow)', async () => {
    const response = await handler(
      post(resumePayload, { 'x-tidebase-signature': sign(resumePayload) })
    )
    // 404 proves the signature gate was passed without touching the network.
    expect(response.status).toBe(404)
  })

  it('rejects signed payloads that are not run.resume', async () => {
    const body = JSON.stringify({ type: 'something.else' })
    const response = await handler(post(body, { 'x-tidebase-signature': sign(body) }))
    expect(response.status).toBe(400)
  })

  it('without a configured secret, unsigned payloads are accepted (documented footgun)', async () => {
    const tide = new Tidebase({ url: 'http://127.0.0.1:9' })
    const open = tide.webhook()
    const response = await open(post(resumePayload))
    expect(response.status).toBe(404)
  })
})

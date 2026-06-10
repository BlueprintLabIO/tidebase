import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { api, createRun, getRunDetail, sleep } from './helpers'

const app = createApp()

type Received = { body: string; signature: string | null }

let receiver: Server
let receiverUrl: string
let received: Received[] = []
let delayMs = 0

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        signature: req.headers['x-tidebase-signature'] as string | null
      })
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      }, delayMs)
    })
  })
  await new Promise<void>((resolve) => receiver.listen(0, resolve))
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`
})

afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve))
})

describe('channel deliveries', () => {
  it('delivers matching events with a verifiable HMAC signature and records the outcome', async () => {
    received = []
    delayMs = 0
    const run = await createRun(app, 'channel-workflow', {
      channels: [
        { type: 'webhook', url: receiverUrl, secret: 'chan-secret', events: ['run.completed'] }
      ]
    })

    // Filtered out: state.updated is not in the channel's event list.
    await api(app, 'PUT', `/runs/${run.id}/state`, { value: { n: 1 } })
    await api(app, 'POST', `/runs/${run.id}/complete`, { result: 'done' })

    expect(received).toHaveLength(1)
    const hook = received[0]
    const parsed = JSON.parse(hook.body)
    expect(parsed.type).toBe('run.completed')
    expect(parsed.runId).toBe(run.id)

    const expected = `sha256=${createHmac('sha256', 'chan-secret').update(hook.body).digest('hex')}`
    expect(hook.signature).toBe(expected)

    const detail = await getRunDetail(app, run.id)
    const deliveries = detail.channelDeliveries.filter(
      (delivery: any) => delivery.eventType === 'run.completed'
    )
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].status).toBe('delivered')
    expect(deliveries[0].httpStatus).toBe(200)
  })

  it('an unreachable channel records a failed delivery but never fails the API call', async () => {
    const run = await createRun(app, 'channel-workflow', {
      channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/dead' }]
    })

    const complete = await api(app, 'POST', `/runs/${run.id}/complete`, { result: 'done' })
    expect(complete.status).toBe(200)

    const detail = await getRunDetail(app, run.id)
    expect(detail.run.status).toBe('completed')
    const delivery = detail.channelDeliveries[0]
    expect(delivery.status).toBe('failed')
    expect(delivery.errorText).toBeTruthy()
  })

  it('a slow channel endpoint does not block other writers to the same run', async () => {
    received = []
    delayMs = 1000
    const run = await createRun(app, 'channel-workflow', {
      channels: [{ type: 'webhook', url: receiverUrl, events: ['state.updated'] }]
    })

    // This write triggers a delivery that hangs for 1s after its tx commits.
    const slowWrite = api(app, 'PUT', `/runs/${run.id}/state`, { value: { n: 1 } })
    await sleep(150)

    // Other writers to the same run must not queue behind the webhook call.
    const start = Date.now()
    const usage = await api(app, 'POST', `/runs/${run.id}/usage`, {
      inputTokens: 1,
      outputTokens: 1
    })
    const elapsed = Date.now() - start
    expect(usage.status).toBe(200)
    expect(elapsed).toBeLessThan(500)

    const slow = await slowWrite
    expect(slow.status).toBe(200)
    delayMs = 0

    const detail = await getRunDetail(app, run.id)
    const seqs = detail.events.map((event: any) => event.seq)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('gate.created is delivered to inline channels with the resolve link', async () => {
    received = []
    delayMs = 0
    const run = await createRun(app)
    await api(app, 'POST', `/runs/${run.id}/gates/begin`, {
      name: 'approve',
      prompt: 'Approve?',
      channels: [{ type: 'webhook', url: receiverUrl, events: ['gate.created'] }]
    })

    expect(received).toHaveLength(1)
    const payload = JSON.parse(received[0].body)
    expect(payload.type).toBe('gate.created')
    expect(payload.payload.gate.resolveUrl).toContain(`/runs/${run.id}/gates/`)
    expect(payload.payload.gate.resolveToken).toBeTruthy()
  })
})

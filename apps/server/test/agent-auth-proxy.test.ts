import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { api } from './helpers'

// End-to-end real custody + proxy: a vaulted secret is injected into a real
// outbound call to a loopback upstream; the agent gets the response, never the secret.

const KEY = 'test-secret-key'
const admin = { authorization: `Bearer ${KEY}` }
const SECRET = 'ghp_THE_REAL_SECRET_VALUE'

let upstream: Server
let port: number
let lastAuthHeader: string | undefined
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    lastAuthHeader = req.headers.authorization
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ pr: 123, path: req.url }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  port = (upstream.address() as { port: number }).port

  savedEnv.TIDEBASE_MASTER_KEY = process.env.TIDEBASE_MASTER_KEY
  savedEnv.TIDEBASE_ALLOW_PRIVATE_PROXY = process.env.TIDEBASE_ALLOW_PRIVATE_PROXY
  process.env.TIDEBASE_MASTER_KEY = randomBytes(32).toString('base64')
  process.env.TIDEBASE_ALLOW_PRIVATE_PROXY = '1' // permit loopback upstream in tests
})

afterAll(async () => {
  process.env.TIDEBASE_MASTER_KEY = savedEnv.TIDEBASE_MASTER_KEY
  process.env.TIDEBASE_ALLOW_PRIVATE_PROXY = savedEnv.TIDEBASE_ALLOW_PRIVATE_PROXY
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

async function setup() {
  const app = createApp({ apiKey: KEY })
  const run = await api(app, 'POST', '/runs/proxy-run', {}, admin)
  const agent = await api(app, 'POST', '/agents', { name: 'proxy-agent', principal: 'proxytest' }, admin)
  const proved = await api(app, 'POST', `/agents/${agent.body.agentId}/prove`, {}, admin)
  const agentAuth = { authorization: `Bearer ${proved.body.sessionToken}` }
  const resource = await api(
    app,
    'POST',
    '/resources',
    {
      name: 'github',
      principal: 'proxytest',
      provider: 'static',
      baseUrl: `http://127.0.0.1:${port}`,
      secret: SECRET,
      scopesAllowed: ['pull_request.write']
    },
    admin
  )
  expect(resource.status).toBe(200)
  return { app, runId: run.body.run.id as string, agentAuth, resource }
}

describe('real credential custody + proxy', () => {
  it('injects the vaulted secret upstream and returns the response, never the secret', async () => {
    const { app, runId, agentAuth } = await setup()

    const grant = await api(
      app,
      'POST',
      `/runs/${runId}/grants`,
      { resource: 'github:repo:acme/app', action: 'pull_request.create', scopes: ['pull_request.write'] },
      agentAuth
    )
    expect(grant.status).toBe(200)
    expect(grant.body.status).toBe('active')

    const used = await api(
      app,
      'POST',
      `/runs/${runId}/grants/${grant.body.grantId}/use`,
      { method: 'POST', path: '/repos/acme/app/pulls', body: { title: 'Fix CI' } },
      agentAuth
    )
    expect(used.status).toBe(200)
    // a REAL call happened (not simulated) and the agent received the upstream body
    expect(used.body.response.simulated).toBe(false)
    expect(used.body.response.status).toBe(200)
    expect(used.body.response.body).toEqual({ pr: 123, path: '/repos/acme/app/pulls' })

    // the upstream actually received the injected credential...
    expect(lastAuthHeader).toBe(`Bearer ${SECRET}`)
    // ...but the agent-facing response never contains it
    expect(JSON.stringify(used.body)).not.toContain(SECRET)

    // and neither does the audit log
    const audit = await api(app, 'GET', `/audit?runId=${runId}`, undefined, admin)
    expect(JSON.stringify(audit.body)).not.toContain(SECRET)
    expect(audit.body.map((e: { type: string }) => e.type)).toContain('grant.used')
  })

  it('the secret never leaves via the resource connect response', async () => {
    const { resource } = await setup()
    expect(JSON.stringify(resource.body)).not.toContain(SECRET)
    expect(Object.keys(resource.body)).not.toContain('secret')
    expect(Object.keys(resource.body)).not.toContain('connectionRef')
  })

  it('blocks the proxy from reaching a private/metadata address end to end (SSRF)', async () => {
    const app = createApp({ apiKey: KEY })
    await api(
      app,
      'POST',
      '/resources',
      { name: 'evilmeta', principal: 'proxytest', provider: 'static', baseUrl: 'http://169.254.169.254', secret: SECRET, scopesAllowed: ['meta.read'] },
      admin
    )
    const run = await api(app, 'POST', '/runs/ssrf-run', {}, admin)
    const agent = await api(app, 'POST', '/agents', { name: 'ssrf-agent', principal: 'proxytest' }, admin)
    const proved = await api(app, 'POST', `/agents/${agent.body.agentId}/prove`, {}, admin)
    const agentAuth = { authorization: `Bearer ${proved.body.sessionToken}` }
    const grant = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants`,
      { resource: 'evilmeta:meta', action: 'meta.read', scopes: ['meta.read'] },
      agentAuth
    )
    expect(grant.status).toBe(200)

    const saved = process.env.TIDEBASE_ALLOW_PRIVATE_PROXY
    process.env.TIDEBASE_ALLOW_PRIVATE_PROXY = '0' // disable the dev escape hatch for this assertion
    try {
      const used = await api(
        app,
        'POST',
        `/runs/${run.body.run.id}/grants/${grant.body.grantId}/use`,
        { method: 'GET', path: '/latest/meta-data/iam/security-credentials' },
        agentAuth
      )
      expect(used.status).toBe(403)
      expect(used.body.code).toBe('ssrf_blocked')
    } finally {
      process.env.TIDEBASE_ALLOW_PRIVATE_PROXY = saved
    }
  })

  it('refuses to store a secret without custody configured (fail closed)', async () => {
    const saved = process.env.TIDEBASE_MASTER_KEY
    delete process.env.TIDEBASE_MASTER_KEY
    try {
      const app = createApp({ apiKey: KEY })
      const res = await api(
        app,
        'POST',
        '/resources',
        { name: 'nokms', principal: 'proxytest', provider: 'static', secret: 'x', baseUrl: `http://127.0.0.1:${port}` },
        admin
      )
      expect(res.status).toBe(503)
      expect(res.body.code).toBe('custody_unavailable')
    } finally {
      process.env.TIDEBASE_MASTER_KEY = saved
    }
  })
})

describe('per-resource path scoping (security review fix F-1)', () => {
  it('rejects a proxied path outside the resource allowed_path_prefix', async () => {
    const app = createApp({ apiKey: KEY })
    await api(
      app, 'POST', '/resources',
      { name: 'scoped', principal: 'proxytest', provider: 'static', baseUrl: `http://127.0.0.1:${port}`, secret: SECRET, scopesAllowed: ['repo.read'], allowedPathPrefix: '/repos/acme/app' },
      admin
    )
    const run = await api(app, 'POST', '/runs/scope-run', {}, admin)
    const agent = await api(app, 'POST', '/agents', { name: 'scope-agent', principal: 'proxytest' }, admin)
    const proved = await api(app, 'POST', `/agents/${agent.body.agentId}/prove`, {}, admin)
    const agentAuth = { authorization: `Bearer ${proved.body.sessionToken}` }
    const grant = await api(app, 'POST', `/runs/${run.body.run.id}/grants`, { resource: 'scoped:repo', action: 'repo.read', scopes: ['repo.read'], maxUses: 5 }, agentAuth)

    // in-prefix path is allowed
    const ok = await api(app, 'POST', `/runs/${run.body.run.id}/grants/${grant.body.grantId}/use`, { method: 'GET', path: '/repos/acme/app/pulls' }, agentAuth)
    expect(ok.status).toBe(200)
    // out-of-prefix path is blocked even though host + verb match
    const blocked = await api(app, 'POST', `/runs/${run.body.run.id}/grants/${grant.body.grantId}/use`, { method: 'GET', path: '/repos/other/secret' }, agentAuth)
    expect(blocked.status).toBe(403)
    expect(blocked.body.code).toBe('ssrf_blocked')
  })
})

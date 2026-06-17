import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { api } from './helpers'

// Adversarial tests for the agent-auth control plane. Each test pins a specific
// threat-model property closed by the hardening passes. Grouped by pass.

const KEY = 'test-secret-key'
const admin = { authorization: `Bearer ${KEY}` }

async function provedAgent(app: ReturnType<typeof createApp>, principal = 'acme') {
  const run = await api(app, 'POST', '/runs/hardening-workflow', {}, admin)
  const agent = await api(app, 'POST', '/agents', { name: `a-${principal}`, principal }, admin)
  const proved = await api(app, 'POST', `/agents/${agent.body.agentId}/prove`, {}, admin)
  return {
    runId: run.body.run.id as string,
    agentId: agent.body.agentId as string,
    agentAuth: { authorization: `Bearer ${proved.body.sessionToken}` }
  }
}

async function connectGithub(app: ReturnType<typeof createApp>, principal = 'acme') {
  return api(
    app,
    'POST',
    '/resources',
    { name: 'github', principal, provider: 'nango', scopesAllowed: ['pull_request.write'] },
    admin
  )
}

async function proveAgentFor(app: ReturnType<typeof createApp>, principal: string, name: string) {
  const agent = await api(app, 'POST', '/agents', { name, principal }, admin)
  const proved = await api(app, 'POST', `/agents/${agent.body.agentId}/prove`, {}, admin)
  return {
    agentId: agent.body.agentId as string,
    agentAuth: { authorization: `Bearer ${proved.body.sessionToken}` }
  }
}

function grantBody(action = 'pull_request.create') {
  return { resource: 'github:repo:acme/app', action, scopes: ['pull_request.write'], reason: 'test' }
}

describe('Pass 1 — authentication & fail-closed', () => {
  it('refuses to broker credentials when no API key is configured (fail closed)', async () => {
    const app = createApp({}) // no apiKey
    const agentsRes = await api(app, 'POST', '/agents', { name: 'x' })
    expect(agentsRes.status).toBe(503)
    expect(agentsRes.body.code).toBe('broker_disabled')
    const resourcesRes = await api(app, 'POST', '/resources', { name: 'github' })
    expect(resourcesRes.status).toBe(503)
    const auditRes = await api(app, 'GET', '/audit')
    expect(auditRes.status).toBe(503)
    // durability core stays reachable without a key (backward compat)
    const run = await api(app, 'POST', '/runs/core-still-open', {})
    expect(run.status).toBe(200)
  })

  it('rejects grant requests presented with the admin key instead of a session', async () => {
    const app = createApp({ apiKey: KEY })
    const { runId } = await provedAgent(app)
    await connectGithub(app)
    const res = await api(
      app,
      'POST',
      `/runs/${runId}/grants`,
      { resource: 'github:repo:acme/app', action: 'pull_request.create', scopes: ['pull_request.write'] },
      admin // admin key, NOT an agent session
    )
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('session_required')
  })

  it('verifies a real Ed25519 keypair proof end to end', async () => {
    const app = createApp({ apiKey: KEY })
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const agent = await api(
      app,
      'POST',
      '/agents',
      { name: 'kp', principal: 'acme', identityKind: 'keypair', publicKey: publicKeyPem },
      admin
    )
    const agentId = agent.body.agentId as string

    const challenge = await api(app, 'POST', `/agents/${agentId}/challenge`, {}, admin)
    expect(challenge.status).toBe(200)
    const signature = cryptoSign(null, Buffer.from(challenge.body.challenge), privateKey).toString('base64')

    const proved = await api(
      app,
      'POST',
      `/agents/${agentId}/prove`,
      { challenge: challenge.body.challenge, signature },
      admin
    )
    expect(proved.status).toBe(200)
    expect(proved.body.sessionToken).toMatch(/^tdb_ags_/)

    // a tampered signature is rejected, and the challenge is single-use
    const challenge2 = await api(app, 'POST', `/agents/${agentId}/challenge`, {}, admin)
    const badSig = cryptoSign(null, Buffer.from('not-the-challenge'), privateKey).toString('base64')
    const rejected = await api(
      app,
      'POST',
      `/agents/${agentId}/prove`,
      { challenge: challenge2.body.challenge, signature: badSig },
      admin
    )
    expect(rejected.status).toBe(401)

    // replay of an already-consumed challenge is rejected
    const replay = await api(
      app,
      'POST',
      `/agents/${agentId}/prove`,
      { challenge: challenge.body.challenge, signature },
      admin
    )
    expect(replay.status).toBe(401)
  })
})

describe('Pass 2 — authorization, tenancy & confused-deputy', () => {
  it('isolates a run to the first principal that brokers on it (cross-tenant denied)', async () => {
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/tenancy-run', {}, admin)
    const runId = run.body.run.id as string
    await connectGithub(app, 'acme')
    await connectGithub(app, 'evil')

    const acme = await proveAgentFor(app, 'acme', 'acme-agent')
    const evil = await proveAgentFor(app, 'evil', 'evil-agent')

    const first = await api(app, 'POST', `/runs/${runId}/grants`, grantBody(), acme.agentAuth)
    expect(first.status).toBe(200) // acme claims the run

    const intruder = await api(app, 'POST', `/runs/${runId}/grants`, grantBody(), evil.agentAuth)
    expect(intruder.status).toBe(403)
    expect(intruder.body.code).toBe('cross_tenant')
  })

  it('forbids one agent from using another agent\'s grant (confused deputy)', async () => {
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/deputy-run', {}, admin)
    const runId = run.body.run.id as string
    await connectGithub(app, 'acme')

    const a1 = await proveAgentFor(app, 'acme', 'a1')
    const a2 = await proveAgentFor(app, 'acme', 'a2') // same principal, different agent

    const grant = await api(
      app,
      'POST',
      `/runs/${runId}/grants`,
      { ...grantBody(), maxUses: 5 },
      a1.agentAuth
    )
    expect(grant.status).toBe(200)

    // a2 (same tenant, so passes tenancy) must NOT be able to use a1's grant
    const stolen = await api(
      app,
      'POST',
      `/runs/${runId}/grants/${grant.body.grantId}/use`,
      { method: 'POST', path: '/repos/acme/app/pulls' },
      a2.agentAuth
    )
    expect(stolen.status).toBe(409)
  })

  it('scopes the audit log to the caller\'s principal', async () => {
    const app = createApp({ apiKey: KEY })
    await connectGithub(app, 'acme')
    await connectGithub(app, 'other')

    const acmeRun = await api(app, 'POST', '/runs/audit-acme', {}, admin)
    const acme = await proveAgentFor(app, 'acme', 'acme-auditor')
    const g = await api(app, 'POST', `/runs/${acmeRun.body.run.id}/grants`, grantBody(), acme.agentAuth)
    await api(
      app,
      'POST',
      `/runs/${acmeRun.body.run.id}/grants/${g.body.grantId}/use`,
      { method: 'POST', path: '/x' },
      acme.agentAuth
    )

    // an agent from a different principal must not see acme's receipts
    const other = await proveAgentFor(app, 'other', 'other-auditor')
    const otherView = await api(app, 'GET', `/audit?runId=${acmeRun.body.run.id}`, undefined, other.agentAuth)
    expect(otherView.status).toBe(200)
    expect(otherView.body).toHaveLength(0)

    // the admin key still sees everything
    const adminView = await api(app, 'GET', `/audit?runId=${acmeRun.body.run.id}`, undefined, admin)
    expect(adminView.body.length).toBeGreaterThan(0)
  })
})

describe('Pass 3 — policy engine & call binding', () => {
  it('hard-denies destructive actions at the endpoint', async () => {
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/policy-deny', {}, admin)
    await connectGithub(app, 'acme')
    const acme = await proveAgentFor(app, 'acme', 'deny-agent')
    const res = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants`,
      { resource: 'github:repo:acme/app', action: 'database.destroy', scopes: ['pull_request.write'] },
      acme.agentAuth
    )
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('policy_denied')
  })

  it('binds the proxied call to the grant action (read grant cannot DELETE)', async () => {
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/policy-bind', {}, admin)
    await api(
      app,
      'POST',
      '/resources',
      { name: 'github', principal: 'acme', provider: 'nango', scopesAllowed: ['repo.read'] },
      admin
    )
    const acme = await proveAgentFor(app, 'acme', 'bind-agent')
    const grant = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants`,
      { resource: 'github:repo:acme/app', action: 'repo.read', scopes: ['repo.read'], maxUses: 3 },
      acme.agentAuth
    )
    expect(grant.status).toBe(200)
    expect(grant.body.status).toBe('active')

    const del = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants/${grant.body.grantId}/use`,
      { method: 'DELETE', path: '/repos/acme/app' },
      acme.agentAuth
    )
    expect(del.status).toBe(403)
    expect(del.body.code).toBe('call_denied')

    const get = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants/${grant.body.grantId}/use`,
      { method: 'GET', path: '/repos/acme/app' },
      acme.agentAuth
    )
    expect(get.status).toBe(200)
  })
})

describe('Pass 4 — lifecycle, expiry, revocation & abuse resistance', () => {
  it('expires grants past their TTL and emits a grant.expired receipt', async () => {
    const { reconcileTick } = await import('../src/reconciler')
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/expiry-run', {}, admin)
    await connectGithub(app, 'acme')
    const acme = await proveAgentFor(app, 'acme', 'expiry-agent')
    const grant = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants`,
      { ...grantBody(), ttlSeconds: 1 },
      acme.agentAuth
    )
    expect(grant.status).toBe(200)

    // Sweep with a clock 5s in the future so the 1s-TTL grant is past expiry.
    // Only one replica sweeps per tick (global advisory lock), so under parallel
    // test workers we retry until our tick actually wins the lock and runs.
    let swept: Awaited<ReturnType<typeof reconcileTick>> = null
    for (let i = 0; i < 50 && !swept; i++) {
      swept = await reconcileTick(new Date(Date.now() + 5000))
      if (!swept) await new Promise((r) => setTimeout(r, 20))
    }
    expect(swept).not.toBeNull()

    const used = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants/${grant.body.grantId}/use`,
      { method: 'POST', path: '/repos/acme/app/pulls' },
      acme.agentAuth
    )
    expect(used.status).toBe(409)

    const audit = await api(app, 'GET', `/audit?runId=${run.body.run.id}`, undefined, admin)
    expect(audit.body.map((e: { type: string }) => e.type)).toContain('grant.expired')
  })

  it('cascades resource revocation to live grants', async () => {
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/revoke-run', {}, admin)
    const resource = await connectGithub(app, 'acme')
    const acme = await proveAgentFor(app, 'acme', 'revoke-agent')
    const grant = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants`,
      { ...grantBody(), maxUses: 5 },
      acme.agentAuth
    )
    expect(grant.status).toBe(200)

    const revoked = await api(app, 'POST', `/resources/${resource.body.resourceId}/revoke`, {}, admin)
    expect(revoked.status).toBe(200)
    expect(revoked.body.grantsRevoked).toBeGreaterThanOrEqual(1)

    // the previously-active grant is now dead
    const used = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants/${grant.body.grantId}/use`,
      { method: 'POST', path: '/repos/acme/app/pulls' },
      acme.agentAuth
    )
    expect(used.status).toBe(409)
  })

  it('rejects oversized broker request bodies', async () => {
    const app = createApp({ apiKey: KEY })
    const huge = 'x'.repeat(70_000)
    const res = await api(app, 'POST', '/agents', { name: 'big', metadata: { blob: huge } }, admin)
    expect(res.status).toBe(413)
    expect(res.body.code).toBe('body_too_large')
  })
})

describe('Pass 5 — secret-handling seam & redaction', () => {
  it('refuses mint mode when no backend can mint (no fake tokens)', async () => {
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/mint-run', {}, admin)
    await connectGithub(app, 'acme')
    const acme = await proveAgentFor(app, 'acme', 'mint-agent')
    const res = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants`,
      { ...grantBody(), mode: 'mint' },
      acme.agentAuth
    )
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('mint_unavailable')
  })

  it('marks proxied calls as simulated in dev and never leaks the connection ref', async () => {
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/sim-run', {}, admin)
    await connectGithub(app, 'acme')
    const acme = await proveAgentFor(app, 'acme', 'sim-agent')
    const grant = await api(app, 'POST', `/runs/${run.body.run.id}/grants`, grantBody(), acme.agentAuth)
    const used = await api(
      app,
      'POST',
      `/runs/${run.body.run.id}/grants/${grant.body.grantId}/use`,
      { method: 'POST', path: '/repos/acme/app/pulls', body: { title: 'x' } },
      acme.agentAuth
    )
    expect(used.status).toBe(200)
    expect(used.body.response.simulated).toBe(true) // honest: not a real call

    // neither the connect response nor the audit log ever exposes connection_ref
    const audit = await api(app, 'GET', `/audit?runId=${run.body.run.id}`, undefined, admin)
    const dump = JSON.stringify({ used: used.body, audit: audit.body })
    expect(dump).not.toContain('connection_ref')
    expect(dump).not.toContain('dev:nango') // the internal connection_ref value
  })

  it('the resource connect response never includes the connection ref', async () => {
    const app = createApp({ apiKey: KEY })
    const res = await connectGithub(app, 'acme')
    expect(res.status).toBe(200)
    expect(Object.keys(res.body)).not.toContain('connectionRef')
    expect(JSON.stringify(res.body)).not.toContain('dev:nango')
  })
})

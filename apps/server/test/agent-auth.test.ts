import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { api } from './helpers'

describe('agent auth and run-bound grants', () => {
  const KEY = 'test-secret-key'
  const auth = { authorization: `Bearer ${KEY}` }

  async function setup() {
    const app = createApp({ apiKey: KEY })
    const run = await api(app, 'POST', '/runs/agent-auth-workflow', {}, auth)
    expect(run.status).toBe(200)

    const agent = await api(
      app,
      'POST',
      '/agents',
      { name: 'ci-fixer', principal: 'acme' },
      auth
    )
    expect(agent.status).toBe(200)

    const proved = await api(app, 'POST', `/agents/${agent.body.agentId}/prove`, {}, auth)
    expect(proved.status).toBe(200)
    const agentAuth = { authorization: `Bearer ${proved.body.sessionToken}` }

    const resource = await api(
      app,
      'POST',
      '/resources',
      {
        name: 'github',
        principal: 'acme',
        provider: 'nango',
        scopesAllowed: ['pull_request.write']
      },
      auth
    )
    expect(resource.status).toBe(200)

    return { app, runId: run.body.run.id as string, agent, agentAuth, resource }
  }

  it('keeps agent sessions scoped to grant/audit surfaces when shared API auth is enabled', async () => {
    const { app, agentAuth } = await setup()

    const runs = await api(app, 'GET', '/runs', undefined, agentAuth)
    expect(runs.status).toBe(401)
  })

  it('requests and uses a proxy grant without exposing held credentials', async () => {
    const { app, runId, agentAuth } = await setup()

    const grant = await api(
      app,
      'POST',
      `/runs/${runId}/grants`,
      {
        resource: 'github:repo:acme/app',
        action: 'pull_request.create',
        scopes: ['pull_request.write'],
        reason: 'open a fix PR'
      },
      agentAuth
    )
    expect(grant.status).toBe(200)
    expect(grant.body.status).toBe('active')
    expect(grant.body.mode).toBe('proxy')
    expect(grant.body.token).toBeUndefined()

    const used = await api(
      app,
      'POST',
      `/runs/${runId}/grants/${grant.body.grantId}/use`,
      { method: 'POST', path: '/repos/acme/app/pulls', body: { title: 'Fix CI' } },
      agentAuth
    )
    expect(used.status).toBe(200)
    expect(used.body.response.proxied).toBe(true)

    const secondUse = await api(
      app,
      'POST',
      `/runs/${runId}/grants/${grant.body.grantId}/use`,
      { method: 'POST', path: '/repos/acme/app/pulls' },
      agentAuth
    )
    expect(secondUse.status).toBe(409)

    const audit = await api(app, 'GET', `/audit?runId=${runId}`, undefined, agentAuth)
    expect(audit.status).toBe(200)
    expect(audit.body.map((entry: { type: string }) => entry.type)).toContain('grant.used')
    expect(JSON.stringify(audit.body)).not.toContain('connection_ref')
    expect(JSON.stringify(audit.body)).not.toContain('tdb_grant_')
  })

  it('denies scopes beyond the connected resource ceiling', async () => {
    const { app, runId, agentAuth } = await setup()
    const grant = await api(
      app,
      'POST',
      `/runs/${runId}/grants`,
      {
        resource: 'github:repo:acme/app',
        action: 'repo.admin',
        scopes: ['admin']
      },
      agentAuth
    )
    expect(grant.status).toBe(403)
  })

  it('routes sensitive actions through an existing approval gate', async () => {
    const { app, runId, agentAuth } = await setup()
    const grant = await api(
      app,
      'POST',
      `/runs/${runId}/grants`,
      {
        resource: 'github:repo:acme/app',
        action: 'deploy.delete',
        scopes: ['pull_request.write']
      },
      agentAuth
    )
    expect(grant.status).toBe(200)
    expect(grant.body.status).toBe('pending')
    expect(grant.body.gateId).toMatch(/^gate_/)

    const detail = await api(app, 'GET', `/runs/${runId}`, undefined, auth)
    const gate = detail.body.gates.find((item: { id: string }) => item.id === grant.body.gateId)
    expect(gate.resolveToken).toBeTruthy()

    const resolved = await api(
      app,
      'POST',
      `/runs/${runId}/gates/${grant.body.gateId}/resolve`,
      { token: gate.resolveToken, decision: 'approved', actor: 'owner' },
      auth
    )
    expect(resolved.status).toBe(200)

    const used = await api(
      app,
      'POST',
      `/runs/${runId}/grants/${grant.body.grantId}/use`,
      { method: 'DELETE', path: '/deployments/old' },
      agentAuth
    )
    expect(used.status).toBe(200)
  })
})

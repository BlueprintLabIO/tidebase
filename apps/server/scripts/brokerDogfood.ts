/**
 * Broker dogfood — exercises the EXACT path Aura's connector store will ride on,
 * end-to-end over real HTTP:
 *   register agent → prove → connect a STATIC secret resource (vaulted) →
 *   request a grant → use it → Tidebase proxies the call to a (GitHub-shaped)
 *   upstream, injecting the secret. We assert the call really happened, the
 *   secret was injected upstream, and the secret NEVER appears in anything the
 *   agent/consumer sees. No OAuth needed — proves the vault+proxy mechanism.
 *
 * Run: TIDEBASE_API_KEY/master set inline; DATABASE_URL → tidebase postgres.
 */
import { serve } from '@hono/node-server'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createApp } from '../src/app.ts'
import { migrate } from '../src/db.ts'

const KEY = 'dogfood-admin-key'
const SECRET = 'ghp_DOGFOOD_SECRET_DO_NOT_LEAK'
const fails: string[] = []
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails.push(msg) }

async function main() {
  process.env.TIDEBASE_MASTER_KEY ??= randomBytes(32).toString('base64')
  process.env.TIDEBASE_ALLOW_PRIVATE_PROXY = '1' // loopback upstream

  // 1) A GitHub-shaped upstream that records the injected auth header.
  let upstreamAuth: string | undefined
  const upstream: Server = createServer((req, res) => {
    upstreamAuth = req.headers.authorization
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ login: 'octocat', via: req.url }))
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const upstreamPort = (upstream.address() as { port: number }).port

  // 2) Broker on (ephemeral port).
  await migrate()
  const server = serve({ fetch: createApp({ apiKey: KEY }).fetch, port: 0 })
  await new Promise((r) => setTimeout(r, 300))
  const brokerPort = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${brokerPort}`
  const admin = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }
  const post = async (path: string, body: unknown, headers: Record<string, string>) =>
    fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) })
  const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) })

  // 3) The flow.
  const run = await j(await post('/runs/dogfood-run', {}, admin))
  ok(run.status === 200, `create run (HTTP ${run.status})`)
  const runId = run.body.run?.id

  const agent = await j(await post('/agents', { name: 'dogfood-agent', principal: 'dogfood' }, admin))
  ok(agent.status === 200, `register agent (HTTP ${agent.status})`)
  const proved = await j(await post(`/agents/${agent.body.agentId}/prove`, {}, admin))
  ok(proved.status === 200 && !!proved.body.sessionToken, `prove → session token (HTTP ${proved.status})`)
  const agentAuth = { authorization: `Bearer ${proved.body.sessionToken}`, 'content-type': 'application/json' }

  const resource = await j(await post('/resources', {
    name: 'github', principal: 'dogfood', provider: 'static',
    baseUrl: `http://127.0.0.1:${upstreamPort}`, secret: SECRET, scopesAllowed: ['repo.read']
  }, admin))
  ok(resource.status === 200, `connect static resource (vaulted) (HTTP ${resource.status})`)
  ok(!JSON.stringify(resource.body).includes(SECRET), 'resource response does NOT contain the secret')

  const grant = await j(await post(`/runs/${runId}/grants`, {
    resource: 'github:repo:acme/app', action: 'repo.read', scopes: ['repo.read']
  }, agentAuth))
  ok(grant.status === 200 && grant.body.status === 'active', `grant request → active (HTTP ${grant.status}, ${grant.body.status})`)

  const used = await j(await post(`/runs/${runId}/grants/${grant.body.grantId}/use`, {
    method: 'GET', path: '/user'
  }, agentAuth))
  ok(used.status === 200, `grant use (HTTP ${used.status})`)
  ok(used.body.response?.simulated === false, 'a REAL upstream call happened (not simulated)')
  ok(used.body.response?.body?.login === 'octocat', 'agent received the upstream response body')
  ok(upstreamAuth === `Bearer ${SECRET}`, `secret WAS injected upstream (upstream saw: ${upstreamAuth ? 'Bearer ***' : 'nothing'})`)
  ok(!JSON.stringify(used.body).includes(SECRET), 'the secret NEVER appears in what the agent sees')

  const audit = await j(await (await fetch(`${base}/audit`, { headers: admin })) as Response)
  ok(audit.status === 200, `audit ledger readable (HTTP ${audit.status})`)
  ok(!JSON.stringify(audit.body).includes(SECRET), 'audit ledger does NOT contain the secret')

  upstream.close()
  await server.close?.()
  console.log(`\n${fails.length === 0 ? '✅ DOGFOOD PASSED — vault + proxy work end-to-end' : `❌ ${fails.length} check(s) failed`}`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('dogfood crashed:', e); process.exit(1) })

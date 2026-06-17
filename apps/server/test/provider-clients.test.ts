import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acquireCredential, resolveBackend } from '../src/providers'

// Verifies the real Nango/OpenBao client wire format against a mock service.
// (Integration against the live services is the remaining external step.)

let server: Server
let port: number
let captured: { url?: string; headers?: IncomingMessage['headers'] } = {}
let respond: () => { status: number; body: unknown } = () => ({ status: 200, body: {} })

beforeAll(async () => {
  server = createServer((req, res) => {
    captured = { url: req.url, headers: req.headers }
    const r = respond()
    res.statusCode = r.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(r.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('Nango client', () => {
  it('fetches the connection with the right URL + auth and extracts the token', async () => {
    respond = () => ({ status: 200, body: { credentials: { access_token: 'oauth_tok_xyz' } } })
    const env = { NANGO_SECRET_KEY: 'sk_test', NANGO_HOST: `http://127.0.0.1:${port}`, NODE_ENV: 'production' } as NodeJS.ProcessEnv
    const res = await acquireCredential(resolveBackend('nango', env), {
      kms: null, connectionRef: 'github-prod::conn_123', resource: 'github:repo:a/b', scopes: [], env,
      loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.credential).toEqual({ scheme: 'bearer', token: 'oauth_tok_xyz' })
    expect(captured.url).toBe('/connection/conn_123?provider_config_key=github-prod')
    expect(captured.headers?.authorization).toBe('Bearer sk_test')
  })

  it('fails closed on a malformed connection reference', async () => {
    const env = { NANGO_SECRET_KEY: 'sk', NANGO_HOST: `http://127.0.0.1:${port}`, NODE_ENV: 'production' } as NodeJS.ProcessEnv
    const res = await acquireCredential(resolveBackend('nango', env), {
      kms: null, connectionRef: 'no-separator', resource: 'r', scopes: [], env, loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(false)
  })
})

describe('OpenBao client', () => {
  it('reads the secret path with the vault token and extracts a KV v2 value', async () => {
    respond = () => ({ status: 200, body: { data: { data: { token: 'vault_secret_abc' } } } })
    const env = { OPENBAO_ADDR: `http://127.0.0.1:${port}`, OPENBAO_TOKEN: 'hvs.root', NODE_ENV: 'production' } as NodeJS.ProcessEnv
    const res = await acquireCredential(resolveBackend('openbao', env), {
      kms: null, connectionRef: 'secret/data/github/acme', resource: 'r', scopes: [], env, loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.credential).toEqual({ scheme: 'bearer', token: 'vault_secret_abc' })
    expect(captured.url).toBe('/v1/secret/data/github/acme')
    expect(captured.headers?.['x-vault-token']).toBe('hvs.root')
  })

  it('fails closed when the service errors', async () => {
    respond = () => ({ status: 403, body: { errors: ['permission denied'] } })
    const env = { OPENBAO_ADDR: `http://127.0.0.1:${port}`, OPENBAO_TOKEN: 't', NODE_ENV: 'production' } as NodeJS.ProcessEnv
    const res = await acquireCredential(resolveBackend('openbao', env), {
      kms: null, connectionRef: 'secret/data/x', resource: 'r', scopes: [], env, loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(false)
  })
})

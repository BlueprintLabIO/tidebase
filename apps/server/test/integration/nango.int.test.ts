import { describe, expect, it } from 'vitest'
import { acquireCredential, resolveBackend } from '../../src/providers'

// LIVE integration test against a self-hosted Nango server. Skipped unless
// NANGO_LIVE=1. Run with:
//   NANGO_LIVE=1 NANGO_HOST=http://localhost:8088 NANGO_SECRET_KEY=<dev key> \
//     npx vitest run test/integration/nango.int.test.ts
// Assumes an integration 'test-apikey' and connection 'conn-acme' seeded with apiKey 'ghp_LIVE_nango_secret_999'.
const live = process.env.NANGO_LIVE === '1'

describe.skipIf(!live)('Nango client — live connection fetch', () => {
  const env = {
    NANGO_SECRET_KEY: process.env.NANGO_SECRET_KEY,
    NANGO_HOST: process.env.NANGO_HOST,
    NODE_ENV: 'production'
  } as NodeJS.ProcessEnv

  it('resolves the nango backend (configured, mintable)', () => {
    const b = resolveBackend('nango', env)
    expect(b.kind).toBe('nango')
    expect(b.canMint).toBe(true)
  })

  it('fetches the real credential for a live connection', async () => {
    const res = await acquireCredential(resolveBackend('nango', env), {
      kms: null,
      connectionRef: 'test-apikey::conn-acme',
      resource: 'airtable:base:acme',
      scopes: [],
      env,
      loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.credential).toEqual({ scheme: 'bearer', token: 'ghp_LIVE_nango_secret_999' })
  })

  it('fails closed for an unknown connection (real 404)', async () => {
    const res = await acquireCredential(resolveBackend('nango', env), {
      kms: null,
      connectionRef: 'test-apikey::does-not-exist',
      resource: 'r',
      scopes: [],
      env,
      loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(false)
  })
})

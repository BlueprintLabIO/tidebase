import { describe, expect, it } from 'vitest'
import { acquireCredential, resolveBackend } from '../../src/providers'

// LIVE integration test against a real OpenBao server. Skipped unless OPENBAO_LIVE
// is set, so the normal hermetic suite/CI does not depend on it. Run with:
//   OPENBAO_LIVE=1 OPENBAO_ADDR=http://localhost:8201 OPENBAO_TOKEN=root-tb-test \
//     npx vitest run test/integration/openbao.int.test.ts
const live = process.env.OPENBAO_LIVE === '1'

describe.skipIf(!live)('OpenBao client — live KV v2', () => {
  const env = {
    OPENBAO_ADDR: process.env.OPENBAO_ADDR,
    OPENBAO_TOKEN: process.env.OPENBAO_TOKEN,
    NODE_ENV: 'production'
  } as NodeJS.ProcessEnv

  it('resolves the openbao backend (configured)', () => {
    const b = resolveBackend('openbao', env)
    expect(b.kind).toBe('openbao')
    expect(b.simulated).toBe(false)
  })

  it('fetches a real secret written to KV v2', async () => {
    const res = await acquireCredential(resolveBackend('openbao', env), {
      kms: null,
      connectionRef: 'secret/data/github/acme',
      resource: 'github:repo:acme/app',
      scopes: [],
      env,
      loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.credential).toEqual({ scheme: 'bearer', token: 'ghp_LIVE_openbao_secret_123' })
  })

  it('fails closed on a missing path (real 404)', async () => {
    const res = await acquireCredential(resolveBackend('openbao', env), {
      kms: null,
      connectionRef: 'secret/data/does/not/exist',
      resource: 'r',
      scopes: [],
      env,
      loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(false)
  })
})

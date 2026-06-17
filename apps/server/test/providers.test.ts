import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptSecret, LocalKms } from '../src/envelope'
import {
  acquireCredential,
  executeProxy,
  normalizeCredential,
  resolveBackend
} from '../src/providers'

const dev = { NODE_ENV: 'development' } as NodeJS.ProcessEnv
const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv

describe('resolveBackend — capability & fail-closed', () => {
  it('uses simulated dev-reference only when dev-reference is allowed', () => {
    expect(resolveBackend('nango', dev).simulated).toBe(true)
    expect(resolveBackend('nango', dev).kind).toBe('dev')
  })

  it('fails closed in production when a real backend is unconfigured', () => {
    const b = resolveBackend('nango', prod)
    expect(b.kind).toBe('failclosed')
    expect(b.simulated).toBe(false)
  })

  it('activates the real backend when configured', () => {
    expect(resolveBackend('nango', { ...prod, NANGO_SECRET_KEY: 'sk' } as NodeJS.ProcessEnv).kind).toBe('nango')
    expect(resolveBackend('openbao', { ...prod, OPENBAO_ADDR: 'https://v', OPENBAO_TOKEN: 't' } as NodeJS.ProcessEnv).kind).toBe('openbao')
    expect(resolveBackend('static', { ...prod, TIDEBASE_MASTER_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv).kind).toBe('vault')
  })

  it('vault custody fails closed in production without a KMS', () => {
    expect(resolveBackend('static', prod).kind).toBe('failclosed')
  })

  it('only mintable backends report canMint', () => {
    expect(resolveBackend('nango', { ...prod, NANGO_SECRET_KEY: 'sk' } as NodeJS.ProcessEnv).canMint).toBe(true)
    expect(resolveBackend('static', { ...prod, TIDEBASE_MASTER_KEY: randomBytes(32).toString('base64') } as NodeJS.ProcessEnv).canMint).toBe(false)
  })

  it('rejects unknown providers', () => {
    expect(resolveBackend('made-up').kind).toBe('failclosed')
  })
})

describe('acquireCredential — vault decrypts envelope material', () => {
  it('decrypts a vaulted credential without exposing the ciphertext', async () => {
    const kms = new LocalKms(randomBytes(32))
    const material = encryptSecret(JSON.stringify({ scheme: 'bearer', token: 'ghp_live_secret' }), kms)
    const res = await acquireCredential(resolveBackend('static', { TIDEBASE_MASTER_KEY: 'x', NODE_ENV: 'production' } as NodeJS.ProcessEnv), {
      kms,
      connectionRef: '',
      resource: 'github:repo:a/b',
      scopes: [],
      env: process.env,
      loadSecretMaterial: async () => ({ material, keyId: kms.keyId })
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.credential).toEqual({ scheme: 'bearer', token: 'ghp_live_secret' })
  })

  it('fails closed when no secret is stored', async () => {
    const kms = new LocalKms(randomBytes(32))
    const res = await acquireCredential({ name: 'vault', kind: 'vault', simulated: false, canMint: false }, {
      kms, connectionRef: '', resource: 'r', scopes: [], env: process.env,
      loadSecretMaterial: async () => null
    })
    expect(res.ok).toBe(false)
  })

  it('dev backend yields a no-secret credential', async () => {
    const res = await acquireCredential(resolveBackend('nango', dev), {
      kms: null, connectionRef: '', resource: 'r', scopes: [], env: dev,
      loadSecretMaterial: async () => null
    })
    expect(res.ok && res.credential.scheme).toBe('none')
  })
})

describe('executeProxy — simulated vs blocked', () => {
  it('simulates (no real call) for a no-secret credential', async () => {
    const out = await executeProxy({
      backend: resolveBackend('nango', dev),
      baseUrl: null,
      call: { method: 'GET', path: '/x' },
      credential: { scheme: 'none' },
      env: dev
    })
    expect(out.ok && out.simulated).toBe(true)
  })

  it('blocks SSRF to a private address even with a real credential', async () => {
    const out = await executeProxy({
      backend: { name: 'vault', kind: 'vault', simulated: false, canMint: false },
      baseUrl: 'http://169.254.169.254',
      call: { method: 'GET', path: '/latest/meta-data' },
      credential: { scheme: 'bearer', token: 'secret' },
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('ssrf_blocked')
  })
})

describe('normalizeCredential', () => {
  it('treats a bare string as a bearer token', () => {
    expect(normalizeCredential('tok')).toEqual({ scheme: 'bearer', token: 'tok' })
  })
  it('accepts structured credentials', () => {
    expect(normalizeCredential({ scheme: 'header', name: 'X-Api-Key', value: 'k' })).toEqual({ scheme: 'header', name: 'X-Api-Key', value: 'k' })
  })
  it('rejects junk', () => {
    expect(normalizeCredential({ nope: true })).toBeNull()
    expect(normalizeCredential(42)).toBeNull()
  })
})

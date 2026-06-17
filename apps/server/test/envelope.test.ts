import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LocalKms, decryptSecret, encryptSecret, resolveKms } from '../src/envelope'

const masterKey = randomBytes(32).toString('base64')

describe('envelope encryption', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const kms = new LocalKms(Buffer.from(masterKey, 'base64'))
    const secret = 'ghp_super_secret_token_value'
    const material = encryptSecret(secret, kms)
    expect(decryptSecret(material, kms)).toBe(secret)
  })

  it('never stores the plaintext in the material', () => {
    const kms = new LocalKms(Buffer.from(masterKey, 'base64'))
    const material = encryptSecret('ghp_super_secret_token_value', kms)
    expect(JSON.stringify(material)).not.toContain('ghp_super_secret_token_value')
  })

  it('uses a unique DEK/iv per encryption (ciphertexts differ for same input)', () => {
    const kms = new LocalKms(Buffer.from(masterKey, 'base64'))
    const a = encryptSecret('same', kms)
    const b = encryptSecret('same', kms)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.wrappedDek).not.toBe(b.wrappedDek)
  })

  it('fails to decrypt with the wrong KEK', () => {
    const kms = new LocalKms(Buffer.from(masterKey, 'base64'))
    const other = new LocalKms(randomBytes(32))
    const material = encryptSecret('secret', kms)
    expect(() => decryptSecret(material, other)).toThrow()
  })

  it('rejects tampered ciphertext (GCM auth)', () => {
    const kms = new LocalKms(Buffer.from(masterKey, 'base64'))
    const material = encryptSecret('secret', kms)
    const tampered = { ...material, ciphertext: Buffer.from('deadbeef', 'hex').toString('base64') }
    expect(() => decryptSecret(tampered, kms)).toThrow()
  })

  it('resolveKms returns null when no key is configured (caller must fail closed)', () => {
    expect(resolveKms({} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('resolveKms builds a LocalKms from a valid master key', () => {
    const kms = resolveKms({ TIDEBASE_MASTER_KEY: masterKey } as NodeJS.ProcessEnv)
    expect(kms?.keyId).toMatch(/^local:/)
  })

  it('rejects a malformed master key', () => {
    expect(() => resolveKms({ TIDEBASE_MASTER_KEY: 'too-short' } as NodeJS.ProcessEnv)).toThrow()
  })

  it('throws for an unimplemented cloud KMS rather than degrading', () => {
    expect(() => resolveKms({ TIDEBASE_KMS: 'aws:arn:xyz' } as NodeJS.ProcessEnv)).toThrow()
  })
})

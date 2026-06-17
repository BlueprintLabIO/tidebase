/**
 * Envelope encryption for credential material at rest.
 *
 * Each secret is encrypted with a fresh random 256-bit DEK (data encryption key)
 * using AES-256-GCM. The DEK itself is wrapped (encrypted) by a KEK (key encryption
 * key) held by a KMS provider. Only the ciphertext + the wrapped DEK are persisted;
 * the plaintext KEK never touches the database and, for cloud KMS, never leaves the
 * KMS at all.
 *
 * The KmsProvider seam lets LocalKms (KEK from an env master key, for self-host)
 * be swapped for AWS/GCP/Vault-transit KMS without touching call sites.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

export type EncryptedMaterial = {
  alg: 'AES-256-GCM'
  keyId: string
  iv: string
  tag: string
  ciphertext: string
  wrappedDek: string
  dekIv: string
  dekTag: string
}

export interface KmsProvider {
  /** Identifies the KEK so the right key is used to unwrap later (key rotation). */
  readonly keyId: string
  wrapDek(dek: Buffer): { wrapped: Buffer; iv: Buffer; tag: Buffer }
  unwrapDek(wrapped: Buffer, iv: Buffer, tag: Buffer): Buffer
}

/** Self-host KMS: KEK supplied as a 32-byte master key (base64) via env. */
export class LocalKms implements KmsProvider {
  readonly keyId: string
  constructor(
    private readonly kek: Buffer,
    label = 'v1'
  ) {
    if (kek.length !== 32) throw new Error('LocalKms master key must be 32 bytes')
    this.keyId = `local:${label}`
  }
  wrapDek(dek: Buffer) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv)
    const wrapped = Buffer.concat([cipher.update(dek), cipher.final()])
    return { wrapped, iv, tag: cipher.getAuthTag() }
  }
  unwrapDek(wrapped: Buffer, iv: Buffer, tag: Buffer) {
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(wrapped), decipher.final()])
  }
}

/**
 * Resolve the configured KMS. Returns null when no key material is configured,
 * which the caller MUST treat as "custody unavailable" and fail closed — never
 * fall back to storing plaintext.
 */
export function resolveKms(env: NodeJS.ProcessEnv = process.env): KmsProvider | null {
  const kmsSpec = env.TIDEBASE_KMS
  if (kmsSpec && kmsSpec !== 'local') {
    // Seam for aws:<arn> / gcp:<resource> / vault:<path>. Not implemented here:
    // throw so a misconfigured prod fails loudly rather than silently degrading.
    throw new Error(`KMS provider '${kmsSpec}' is not implemented in this build`)
  }
  const master = env.TIDEBASE_MASTER_KEY
  if (!master) return null
  const kek = Buffer.from(master, 'base64')
  if (kek.length !== 32) {
    throw new Error('TIDEBASE_MASTER_KEY must be 32 bytes, base64-encoded (generate: openssl rand -base64 32)')
  }
  return new LocalKms(kek, env.TIDEBASE_MASTER_KEY_LABEL ?? 'v1')
}

export function encryptSecret(plaintext: string, kms: KmsProvider): EncryptedMaterial {
  const dek = randomBytes(32)
  try {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', dek, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const { wrapped, iv: dekIv, tag: dekTag } = kms.wrapDek(dek)
    return {
      alg: 'AES-256-GCM',
      keyId: kms.keyId,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      wrappedDek: wrapped.toString('base64'),
      dekIv: dekIv.toString('base64'),
      dekTag: dekTag.toString('base64')
    }
  } finally {
    dek.fill(0) // best-effort zeroing of the plaintext DEK
  }
}

export function decryptSecret(material: EncryptedMaterial, kms: KmsProvider): string {
  if (!keyIdMatches(material.keyId, kms.keyId)) {
    throw new Error(`material was wrapped by key '${material.keyId}', not '${kms.keyId}'`)
  }
  const dek = kms.unwrapDek(
    Buffer.from(material.wrappedDek, 'base64'),
    Buffer.from(material.dekIv, 'base64'),
    Buffer.from(material.dekTag, 'base64')
  )
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(material.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(material.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(material.ciphertext, 'base64')),
      decipher.final()
    ])
    return plaintext.toString('utf8')
  } finally {
    dek.fill(0)
  }
}

function keyIdMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

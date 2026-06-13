import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { upsertEnv } from '../src/cli'

function tmpEnv(initial?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tide-env-'))
  const path = join(dir, '.env')
  if (initial !== undefined) writeFileSync(path, initial)
  return path
}

describe('upsertEnv (tidebase signup writes credentials)', () => {
  it('creates .env with the credentials when none exists', () => {
    const path = tmpEnv()
    upsertEnv(path, { TIDEBASE_URL: 'https://x', TIDEBASE_API_KEY: 'tbk_1' })
    expect(readFileSync(path, 'utf8')).toBe('TIDEBASE_URL=https://x\nTIDEBASE_API_KEY=tbk_1\n')
  })

  it('updates existing Tidebase keys in place without touching other vars', () => {
    const path = tmpEnv('DATABASE_URL=postgres://local\nTIDEBASE_API_KEY=old\nPORT=3000\n')
    upsertEnv(path, { TIDEBASE_URL: 'https://x', TIDEBASE_API_KEY: 'tbk_new' })
    const out = readFileSync(path, 'utf8')
    expect(out).toContain('DATABASE_URL=postgres://local')
    expect(out).toContain('PORT=3000')
    expect(out).toContain('TIDEBASE_API_KEY=tbk_new')
    expect(out).not.toContain('TIDEBASE_API_KEY=old')
    // appended, not duplicated
    expect(out.match(/TIDEBASE_API_KEY=/g)).toHaveLength(1)
    expect(out.match(/TIDEBASE_URL=/g)).toHaveLength(1)
  })

  it('is idempotent — re-running with the same values is a no-op', () => {
    const path = tmpEnv()
    const first = upsertEnv(path, { TIDEBASE_URL: 'https://x', TIDEBASE_API_KEY: 'tbk_1' })
    const second = upsertEnv(path, { TIDEBASE_URL: 'https://x', TIDEBASE_API_KEY: 'tbk_1' })
    expect(second).toBe(first)
  })

  it('does not clobber a var whose name is a prefix of a Tidebase key', () => {
    const path = tmpEnv('TIDEBASE_URL_BACKUP=keepme\n')
    upsertEnv(path, { TIDEBASE_URL: 'https://x' })
    const out = readFileSync(path, 'utf8')
    expect(out).toContain('TIDEBASE_URL_BACKUP=keepme')
    expect(out).toContain('TIDEBASE_URL=https://x')
  })
})

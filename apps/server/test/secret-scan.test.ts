import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// CI secret-scan: a structural guard against two failure modes —
//  1. a real secret accidentally hard-coded into source, and
//  2. a code path that returns secret-bearing columns to clients.
// Runs over src/ only (test fixtures intentionally use fake secrets).

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

const files = sourceFiles(srcDir)

describe('secret scan over src/', () => {
  // Known real-secret prefixes / blocks. Fixtures live in test/, which is excluded.
  const patterns: Array<{ name: string; re: RegExp }> = [
    { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { name: 'GitHub token', re: /ghp_[A-Za-z0-9]{20,}/ },
    { name: 'Stripe live key', re: /sk_live_[A-Za-z0-9]{16,}/ },
    { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ }
  ]

  it('contains no hard-coded secrets', () => {
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const { name, re } of patterns) {
        if (re.test(text)) hits.push(`${name} in ${file}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('never selects secret-bearing columns into a client response shape', () => {
    // connection_ref / material_json are internal-only; they must never appear in
    // a map*-to-client function. Cheap heuristic: those identifiers must not be
    // referenced inside the mapResource/mapAgent/mapGrant/grantReceipt helpers.
    const app = readFileSync(join(srcDir, 'app.ts'), 'utf8')
    for (const mapper of ['function mapResource', 'function mapGrant', 'function grantReceipt']) {
      const start = app.indexOf(mapper)
      expect(start, mapper).toBeGreaterThan(-1)
      const body = app.slice(start, start + 600)
      expect(body, `${mapper} must not expose connection_ref`).not.toContain('connection_ref')
      expect(body, `${mapper} must not expose material_json`).not.toContain('material_json')
      expect(body, `${mapper} must not expose token_hash`).not.toContain('token_hash')
    }
  })
})

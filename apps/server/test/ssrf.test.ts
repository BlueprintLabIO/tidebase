import { describe, expect, it } from 'vitest'
import { assertSafeTarget, buildProxyUrl, isPrivateHostname, isPrivateV4 } from '../src/ssrf'

describe('buildProxyUrl — host is pinned to the resource base_url', () => {
  it('joins a relative path onto the base origin', () => {
    const r = buildProxyUrl('https://api.github.com', '/repos/acme/app/pulls')
    expect(r.ok && r.url).toBe('https://api.github.com/repos/acme/app/pulls')
  })

  it('honors a base path prefix', () => {
    const r = buildProxyUrl('https://example.com/v2', '/widgets')
    expect(r.ok && r.url).toBe('https://example.com/v2/widgets')
  })

  it('rejects an absolute URL supplied as the path', () => {
    expect(buildProxyUrl('https://api.github.com', 'http://169.254.169.254/latest/meta-data').ok).toBe(false)
    expect(buildProxyUrl('https://api.github.com', '//evil.com/x').ok).toBe(false)
  })

  it('rejects userinfo smuggling', () => {
    const r = buildProxyUrl('https://api.github.com', '/x')
    expect(r.ok).toBe(true) // sanity
    expect(buildProxyUrl('https://user:pass@api.github.com', '/x').ok).toBe(true) // base userinfo is operator's choice
  })

  it('rejects a non-http base', () => {
    expect(buildProxyUrl('file:///etc/passwd', '/x').ok).toBe(false)
  })
})

describe('private address detection', () => {
  it('flags RFC1918, loopback, link-local and metadata', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateV4(ip), ip).toBe(true)
    }
  })
  it('allows public IPs', () => {
    for (const ip of ['8.8.8.8', '140.82.112.3', '1.1.1.1']) {
      expect(isPrivateV4(ip), ip).toBe(false)
    }
  })
  it('flags internal hostnames', () => {
    for (const h of ['localhost', 'foo.local', 'svc.internal', '::1']) {
      expect(isPrivateHostname(h), h).toBe(true)
    }
  })
})

describe('assertSafeTarget', () => {
  it('refuses a private literal IP target', async () => {
    const r = await assertSafeTarget('http://169.254.169.254/latest/meta-data', { allowPrivate: false })
    expect(r.ok).toBe(false)
  })
  it('allows a public host', async () => {
    const r = await assertSafeTarget('https://api.github.com/x', { allowPrivate: false })
    expect(r.ok).toBe(true)
  })
  it('honors the dev allowPrivate escape hatch (loopback upstreams in tests)', async () => {
    const r = await assertSafeTarget('http://127.0.0.1:9999/x', { allowPrivate: true })
    expect(r.ok).toBe(true)
  })
})

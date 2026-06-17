/**
 * SSRF defense for the credential proxy.
 *
 * The proxy makes a real outbound HTTP call to a path the AGENT supplies, using a
 * secret the agent never sees. Without guards that is a textbook SSRF primitive
 * (hit cloud metadata at 169.254.169.254, internal services, etc.). Two layers:
 *
 *   1. buildProxyUrl: the agent may only supply a *path*. The host/scheme are
 *      pinned to the resource's operator-configured base_url; absolute URLs and
 *      protocol-relative paths are rejected, and the joined target must stay on
 *      the same origin.
 *   2. assertSafeTarget: resolve the host and refuse private/loopback/link-local/
 *      CGNAT/metadata addresses (DNS-rebinding safe). Gated by allowPrivate, which
 *      defaults off and is only enabled for dev/test loopback upstreams.
 */
import { lookup } from 'node:dns/promises'

export type UrlResult = { ok: true; url: string } | { ok: false; reason: string }

export function buildProxyUrl(baseUrl: string, agentPath: string): UrlResult {
  if (/^[a-z][a-z0-9+.-]*:/i.test(agentPath) || agentPath.startsWith('//')) {
    return { ok: false, reason: 'path must be relative; absolute URLs and protocol-relative paths are rejected' }
  }
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return { ok: false, reason: 'resource has an invalid base_url' }
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    return { ok: false, reason: 'base_url must be http(s)' }
  }
  const prefix = base.pathname.replace(/\/$/, '')
  const path = agentPath.startsWith('/') ? agentPath : `/${agentPath}`
  let target: URL
  try {
    target = new URL(prefix + path, base.origin)
  } catch {
    return { ok: false, reason: 'invalid target path' }
  }
  // The joined target must not have escaped the base origin (defense against
  // path tricks). Userinfo (user:pass@) in the path is also disallowed.
  if (target.origin !== base.origin || target.username || target.password) {
    return { ok: false, reason: 'target must stay on the resource base_url origin' }
  }
  return { ok: true, url: target.toString() }
}

export function isPrivateV4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return true // malformed → treat as unsafe
  const [a, b] = o
  if (a === 0 || a === 10 || a === 127) return true // this-network, RFC1918, loopback
  if (a === 169 && b === 254) return true // link-local + cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF
  if (a >= 224) return true // multicast / reserved
  return false
}

export function isPrivateV6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true // unique local
  if (h.startsWith('fe80')) return true // link-local
  if (h.startsWith('::ffff:')) return isPrivateV4(h.slice('::ffff:'.length)) // v4-mapped
  return false
}

export function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateV4(h)
  if (h.includes(':')) return isPrivateV6(h)
  return false
}

export async function assertSafeTarget(
  url: string,
  opts: { allowPrivate: boolean }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.allowPrivate) return { ok: true }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, reason: 'invalid target url' }
  }
  if (isPrivateHostname(u.hostname)) {
    return { ok: false, reason: 'target host is private/internal' }
  }
  // Resolve the name and re-check, so a public name that points at an internal
  // IP (DNS rebinding) is still refused.
  try {
    const { address } = await lookup(u.hostname)
    if (isPrivateV4(address) || isPrivateV6(address)) {
      return { ok: false, reason: 'target resolves to a private/internal address' }
    }
  } catch {
    return { ok: false, reason: 'target host did not resolve' }
  }
  return { ok: true }
}

export function allowPrivateProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TIDEBASE_ALLOW_PRIVATE_PROXY === '1'
}

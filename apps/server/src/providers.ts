/**
 * Credential provider seam — the boundary between "Tidebase decides" and the
 * backends that actually HOLD the secret. Three responsibilities, kept separate:
 *
 *   resolveBackend()    pure capability/availability decision (which backend, can
 *                       it mint, is it configured) — no I/O, easy to test.
 *   acquireCredential() obtains the live credential: vault decrypts envelope
 *                       material locally; nango/openbao fetch from the service.
 *   executeProxy()      makes the real outbound call with the credential injected,
 *                       behind the SSRF guard. The agent gets the response, never
 *                       the credential.
 *
 * Fail-closed throughout: an unconfigured real backend never fabricates a result;
 * the simulated dev-reference path is the ONLY one that returns success without a
 * backend, and only when dev-reference is allowed.
 */
import { decryptSecret, type EncryptedMaterial, type KmsProvider } from './envelope.js'
import { allowPrivateProxy, assertSafeTarget, buildProxyUrl } from './ssrf.js'

export type ProxyCall = { method: string; path: string; body?: unknown }

export type ProxyOutcome =
  | { ok: true; simulated: boolean; status: number; provider: string; body?: unknown }
  | { ok: false; code: 'backend_not_configured' | 'provider_error' | 'ssrf_blocked' | 'upstream_unreachable'; provider: string; message: string }

export type Credential =
  | { scheme: 'none' } // dev/simulated — no real secret
  | { scheme: 'bearer'; token: string }
  | { scheme: 'header'; name: string; value: string }
  | { scheme: 'basic'; username: string; password: string }

export type BackendKind = 'dev' | 'vault' | 'nango' | 'openbao' | 'failclosed'

export type Backend = {
  name: string
  kind: BackendKind
  simulated: boolean
  canMint: boolean
  failReason?: string
}

function devReferenceAllowed(env: NodeJS.ProcessEnv): boolean {
  const isProduction = (env.NODE_ENV ?? env.TIDEBASE_ENV) === 'production'
  return env.TIDEBASE_ALLOW_DEV_REFERENCE === '1' || !isProduction
}

export function kmsConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TIDEBASE_MASTER_KEY) || (Boolean(env.TIDEBASE_KMS) && env.TIDEBASE_KMS !== 'local')
}

/** Decide which backend serves a resource's provider, and whether it is available. */
export function resolveBackend(providerName: string, env: NodeJS.ProcessEnv = process.env): Backend {
  const devOk = devReferenceAllowed(env)
  const dev = (): Backend => ({ name: 'dev-reference', kind: 'dev', simulated: true, canMint: false })
  const failClosed = (name: string, reason: string): Backend => ({ name, kind: 'failclosed', simulated: false, canMint: false, failReason: reason })

  switch (providerName) {
    case 'static': // a directly-supplied credential we vault with envelope encryption
      if (kmsConfigured(env)) return { name: 'vault', kind: 'vault', simulated: false, canMint: false }
      return devOk ? dev() : failClosed('vault', 'TIDEBASE_MASTER_KEY/KMS not configured for custody')
    case 'nango':
      if (env.NANGO_SECRET_KEY) return { name: 'nango', kind: 'nango', simulated: false, canMint: true }
      return devOk ? dev() : failClosed('nango', 'NANGO_SECRET_KEY not configured')
    case 'openbao':
      if (env.OPENBAO_ADDR && env.OPENBAO_TOKEN) return { name: 'openbao', kind: 'openbao', simulated: false, canMint: true }
      return devOk ? dev() : failClosed('openbao', 'OPENBAO_ADDR/OPENBAO_TOKEN not configured')
    default:
      return failClosed(providerName, `unknown provider '${providerName}'`)
  }
}

export type AcquireContext = {
  loadSecretMaterial: () => Promise<{ material: EncryptedMaterial; keyId: string } | null>
  kms: KmsProvider | null
  connectionRef: string
  resource: string
  scopes: string[]
  env: NodeJS.ProcessEnv
}

export type AcquireResult =
  | { ok: true; credential: Credential }
  | { ok: false; code: 'backend_not_configured' | 'provider_error'; message: string }

/** Obtain the live credential for a backend. Never returns it to the agent. */
export async function acquireCredential(backend: Backend, ctx: AcquireContext): Promise<AcquireResult> {
  switch (backend.kind) {
    case 'dev':
      return { ok: true, credential: { scheme: 'none' } }
    case 'failclosed':
      return { ok: false, code: 'backend_not_configured', message: backend.failReason ?? 'backend not configured' }
    case 'vault': {
      if (!ctx.kms) return { ok: false, code: 'backend_not_configured', message: 'KMS not available' }
      const stored = await ctx.loadSecretMaterial()
      if (!stored) return { ok: false, code: 'backend_not_configured', message: 'no secret stored for resource' }
      let credential: Credential
      try {
        credential = JSON.parse(decryptSecret(stored.material, ctx.kms)) as Credential
      } catch {
        return { ok: false, code: 'provider_error', message: 'failed to decrypt stored credential' }
      }
      return { ok: true, credential }
    }
    case 'nango':
      return acquireFromNango(ctx)
    case 'openbao':
      return acquireFromOpenBao(ctx)
    default:
      return { ok: false, code: 'backend_not_configured', message: 'unsupported backend' }
  }
}

// --- Real external backend clients ----------------------------------------
// These build and issue the actual service requests. They activate only when
// configured; integration testing against live Nango/OpenBao is the remaining
// external step (documented in the design doc).

async function acquireFromNango(ctx: AcquireContext): Promise<AcquireResult> {
  const host = ctx.env.NANGO_HOST ?? 'https://api.nango.dev'
  const key = ctx.env.NANGO_SECRET_KEY!
  // connectionRef carries "<providerConfigKey>:<connectionId>".
  const [providerConfigKey, connectionId] = ctx.connectionRef.split('::')
  if (!providerConfigKey || !connectionId) {
    return { ok: false, code: 'provider_error', message: 'malformed nango connection reference' }
  }
  const url = `${host.replace(/\/$/, '')}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerConfigKey)}`
  try {
    const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${key}` } }, 10_000)
    if (!res.ok) return { ok: false, code: 'provider_error', message: `nango responded ${res.status}` }
    const data = (await res.json()) as { credentials?: { access_token?: string; apiKey?: string } }
    const token = data.credentials?.access_token ?? data.credentials?.apiKey
    if (!token) return { ok: false, code: 'provider_error', message: 'nango returned no usable credential' }
    return { ok: true, credential: { scheme: 'bearer', token } }
  } catch {
    return { ok: false, code: 'provider_error', message: 'nango request failed' }
  }
}

async function acquireFromOpenBao(ctx: AcquireContext): Promise<AcquireResult> {
  const addr = ctx.env.OPENBAO_ADDR!.replace(/\/$/, '')
  const token = ctx.env.OPENBAO_TOKEN!
  // connectionRef carries the secret path, e.g. "secret/data/github/acme".
  const url = `${addr}/v1/${ctx.connectionRef.replace(/^\//, '')}`
  try {
    const res = await fetchWithTimeout(url, { headers: { 'x-vault-token': token } }, 10_000)
    if (!res.ok) return { ok: false, code: 'provider_error', message: `openbao responded ${res.status}` }
    const data = (await res.json()) as { data?: Record<string, unknown> }
    // KV v2 nests under data.data; KV v1 / dynamic creds sit at data.
    const nested = (data.data as Record<string, unknown> | undefined)?.data
    const inner = ((nested && typeof nested === 'object' ? nested : data.data) ?? {}) as Record<string, unknown>
    const value = inner.token ?? inner.access_token ?? inner.api_key
    if (!value || typeof value !== 'string') {
      return { ok: false, code: 'provider_error', message: 'openbao returned no usable credential' }
    }
    return { ok: true, credential: { scheme: 'bearer', token: value } }
  } catch {
    return { ok: false, code: 'provider_error', message: 'openbao request failed' }
  }
}

export type ExecuteContext = {
  backend: Backend
  baseUrl: string | null
  /** When set, the proxied path must start with this prefix (per-resource scoping). */
  allowedPathPrefix?: string | null
  call: ProxyCall
  credential: Credential
  env: NodeJS.ProcessEnv
}

const MAX_PROXY_RESPONSE_BYTES = 1024 * 1024 // 1 MiB cap on upstream responses

/** Perform the proxied call with the credential injected, behind the SSRF guard. */
export async function executeProxy(ctx: ExecuteContext): Promise<ProxyOutcome> {
  if (ctx.credential.scheme === 'none') {
    // dev/simulated: never makes a real call, never touches a secret.
    return { ok: true, simulated: true, status: 200, provider: ctx.backend.name }
  }
  if (!ctx.baseUrl) {
    return { ok: false, code: 'backend_not_configured', provider: ctx.backend.name, message: 'resource has no base_url to proxy to' }
  }
  // Per-resource path scoping: narrow from "any path on host" to a path subtree.
  if (ctx.allowedPathPrefix) {
    const p = ctx.call.path.startsWith('/') ? ctx.call.path : `/${ctx.call.path}`
    if (!p.startsWith(ctx.allowedPathPrefix)) {
      return { ok: false, code: 'ssrf_blocked', provider: ctx.backend.name, message: `path outside the resource's allowed prefix '${ctx.allowedPathPrefix}'` }
    }
  }
  const built = buildProxyUrl(ctx.baseUrl, ctx.call.path)
  if (!built.ok) return { ok: false, code: 'ssrf_blocked', provider: ctx.backend.name, message: built.reason }
  const safe = await assertSafeTarget(built.url, { allowPrivate: allowPrivateProxy(ctx.env) })
  if (!safe.ok) return { ok: false, code: 'ssrf_blocked', provider: ctx.backend.name, message: safe.reason }

  const headers = injectCredential(ctx.credential, { 'content-type': 'application/json' })
  try {
    const res = await fetchWithTimeout(
      built.url,
      {
        method: ctx.call.method,
        headers,
        // Do NOT follow redirects: a 3xx to another host would bypass the SSRF
        // check and could forward a custom-header credential off-origin. The agent
        // receives the 3xx and decides.
        redirect: 'manual',
        body: ctx.call.body === undefined || ctx.call.method.toUpperCase() === 'GET' ? undefined : JSON.stringify(ctx.call.body)
      },
      15_000
    )
    const body = await safeReadBody(res)
    return { ok: true, simulated: false, status: res.status, provider: ctx.backend.name, body }
  } catch {
    return { ok: false, code: 'upstream_unreachable', provider: ctx.backend.name, message: 'upstream request failed or timed out' }
  }
}

// Headers an injected 'header'-scheme credential must never set (request smuggling,
// host override, connection control).
const BLOCKED_INJECT_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'authorization', 'cookie'
])

function injectCredential(credential: Credential, base: Record<string, string>): Record<string, string> {
  const headers = { ...base }
  switch (credential.scheme) {
    case 'bearer':
      headers.authorization = `Bearer ${credential.token}`
      break
    case 'header': {
      const name = credential.name.toLowerCase()
      // Never let an operator-configured header name clobber a control header.
      if (!BLOCKED_INJECT_HEADERS.has(name)) headers[name] = credential.value
      break
    }
    case 'basic':
      headers.authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`
      break
    case 'none':
      break
  }
  return headers
}

async function safeReadBody(res: Response): Promise<unknown> {
  // Cap how much we read so a huge upstream response cannot exhaust memory.
  const buf = await res.arrayBuffer()
  const bytes = Buffer.from(buf.byteLength > MAX_PROXY_RESPONSE_BYTES ? buf.slice(0, MAX_PROXY_RESPONSE_BYTES) : buf)
  const text = bytes.toString('utf8')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Normalize a connect-time secret into the stored Credential shape. */
export function normalizeCredential(secret: unknown): Credential | null {
  if (typeof secret === 'string') return { scheme: 'bearer', token: secret }
  if (secret && typeof secret === 'object') {
    const s = secret as Record<string, unknown>
    if (s.scheme === 'bearer' && typeof s.token === 'string') return { scheme: 'bearer', token: s.token }
    if (s.scheme === 'header' && typeof s.name === 'string' && typeof s.value === 'string') {
      return { scheme: 'header', name: s.name, value: s.value }
    }
    if (s.scheme === 'basic' && typeof s.username === 'string' && typeof s.password === 'string') {
      return { scheme: 'basic', username: s.username, password: s.password }
    }
  }
  return null
}

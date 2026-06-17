/**
 * Agent authentication & run-bound authorization — the Tidebase auth control-plane layer.
 *
 * Trust boundary (the one sentence the product is built on):
 *   SPIRE / IdentityProvider proves WHAT the agent is.
 *   OpenBao / Nango hold WHAT the agent might need.
 *   Tidebase decides WHAT the agent may do RIGHT NOW.
 *
 * Security invariant: the agent NEVER receives a long-lived credential. Tidebase
 * either mints a short-lived, scoped, single-use grant (`mode: 'mint'`) or proxies
 * the call so the secret never leaves the boundary (`mode: 'proxy'`, the default).
 *
 * Status: v0 API surface + dev-mode reference path. Server-side secret custody
 * (OpenBao/Nango) and SPIRE attestation are pluggable backends — see DESIGN_agent_auth.md.
 * This module intentionally exposes ZERO OpenBao/SPIRE concepts (no SVID, mount,
 * lease path, secret engine, attestor) in the public API.
 */

import type { CapabilityIntent } from './index.js'

// ---------------------------------------------------------------------------
// Identity — pluggable. SPIRE is one provider, never a requirement.
// ---------------------------------------------------------------------------

export type IdentityKind = 'dev_token' | 'keypair' | 'cloud_key' | 'spire'

export type AgentIdentity = {
  agentId: string
  name: string
  principal: string | null
  identityKind: IdentityKind
  status: 'active' | 'disabled' | 'revoked'
}

export type AgentRegisterOptions = {
  name: string
  principal?: string
  /** Selects the proof mechanism. Defaults to the server's configured provider
   *  ('dev_token' in dev, 'keypair'/'cloud_key' in cloud). Pass 'spire' only when
   *  the agent runs as an attested workload in a SPIRE-meshed environment. */
  identityKind?: IdentityKind
  publicKey?: string
  metadata?: Record<string, unknown>
}

export type ProveOptions = {
  /** Dev provider: a bearer token. Keypair: a `challenge` (from agents.challenge)
   *  plus its Ed25519 `signature`. SPIRE: handled out-of-band via the workload API. */
  token?: string
  challenge?: string
  signature?: string
}

export type Challenge = {
  /** Opaque single-use challenge to sign with the agent's private key. */
  challenge: string
  expiresAt: string
}

export type ProveResult = {
  agentId: string
  /** Short-lived session token the agent presents on subsequent calls. */
  sessionToken: string
  expiresAt: string
}

/**
 * Provider seam. v0 ships DevTokenProvider + KeypairProvider; SpireProvider is a
 * stub that delegates to the SPIRE workload API server-side. Adding SPIRE later
 * is NOT an API break — the public surface above never changes.
 */
export interface IdentityProvider {
  readonly kind: IdentityKind
  prove(agentId: string, opts: ProveOptions): Promise<ProveResult>
}

// ---------------------------------------------------------------------------
// Resources — delegated third-party connections (Nango/OpenBao live behind these).
// ---------------------------------------------------------------------------

export type ResourceConnectOptions = {
  /** 'nango' for user-delegated SaaS OAuth, 'openbao' for held secrets/dynamic
   *  creds, 'static' for a directly supplied key vaulted by Tidebase. Default 'nango'. */
  provider?: 'nango' | 'openbao' | 'static'
  principal?: string
  /** Ceiling of scopes any grant against this resource may request. */
  scopesAllowed?: string[]
  /** Upstream API base the proxy is pinned to (SSRF defense). Required to proxy. */
  baseUrl?: string
  /** provider:'static' only — the credential to vault (envelope-encrypted at rest).
   *  A bearer-token string or a structured credential. Never returned or logged. */
  secret?: string | { scheme: 'bearer'; token: string } | { scheme: 'header'; name: string; value: string } | { scheme: 'basic'; username: string; password: string }
  /** provider:'nango'|'openbao' — opaque pointer to the held secret
   *  (e.g. '<providerConfigKey>::<connectionId>' or a vault path). */
  connectionRef?: string
  metadata?: Record<string, unknown>
}

export type Resource = {
  resourceId: string
  name: string
  provider: 'nango' | 'openbao' | 'static'
  status: 'connected' | 'revoked' | 'error'
  // NOTE: connection_ref (the internal pointer to the held secret) is deliberately absent.
}

// ---------------------------------------------------------------------------
// Grants — "what may this agent do right now". The product.
// ---------------------------------------------------------------------------

export type GrantRequest = {
  /** Target resource + object, e.g. 'github:repo:acme/app'. */
  resource: string
  /** Action, e.g. 'pull_request.create'. Drives policy + least-privilege scope. */
  action: string
  reason?: string
  scopes?: string[]
  /** 'proxy' (default) keeps the secret behind the boundary; 'mint' hands the
   *  agent a short-lived scoped token. Policy may force 'proxy'. */
  mode?: 'proxy' | 'mint'
  ttlSeconds?: number
  maxUses?: number
}

export type GrantStatus =
  | 'pending' | 'approved' | 'active' | 'denied' | 'expired' | 'revoked' | 'used'

export type Grant = {
  grantId: string
  runId: string
  resource: string
  action: string
  status: GrantStatus
  mode: 'proxy' | 'mint'
  /** Present only when status='active' AND mode='mint'. Short-lived, scoped,
   *  single-use by default. Absent in proxy mode — there is nothing to hand out. */
  token?: string
  expiresAt: string | null
  /** Set when policy routed the request through an approval gate (reuses RunGates). */
  gateId?: string | null
}

/** Result of proxying a call through a grant. `response.body` is the upstream
 *  response; `simulated` is true for the dev-reference backend (no real call). */
export type GrantUseResult = {
  grant: Grant
  response: {
    ok: true
    mode: 'proxy' | 'mint'
    proxied: true
    simulated: boolean
    provider: string
    status: number
    body?: unknown
    method: string
    path: string
  }
}

/** A grant.* receipt, read back from the run's append-only event log. */
export type AuditEntry = {
  seq: number
  type: string            // grant.requested | grant.approved | grant.minted | grant.used | ...
  grantId: string
  resource: string
  action: string
  agentId: string | null
  at: string
  // Never contains the secret or token.
}

export type AuditQuery = {
  runId?: string
  agentId?: string
  resource?: string
  types?: string[]
  limit?: number
}

// ---------------------------------------------------------------------------
// Client surface. Mirrors the existing SDK idiom: top-level clients constructed
// with the Tidebase transport, run-scoped clients constructed with (client, runId).
// `RequestTransport` is the narrow slice of `Tidebase` these clients depend on.
// ---------------------------------------------------------------------------

export interface RequestTransport {
  request<T>(path: string, init?: { method?: string; body?: string }): Promise<T>
}

export class AgentsClient {
  constructor(private readonly client: RequestTransport) {}

  async register(opts: AgentRegisterOptions): Promise<AgentIdentity> {
    return this.client.request('/agents', {
      method: 'POST',
      body: JSON.stringify(opts)
    })
  }

  /** Request a single-use challenge for a keypair/cloud_key agent to sign. */
  async challenge(agentId: string): Promise<Challenge> {
    return this.client.request(`/agents/${agentId}/challenge`, { method: 'POST' })
  }

  /** Exchange a proof for a short-lived session token. */
  async prove(agentId: string, opts: ProveOptions = {}): Promise<ProveResult> {
    return this.client.request(`/agents/${agentId}/prove`, {
      method: 'POST',
      body: JSON.stringify(opts)
    })
  }

  async get(agentId: string): Promise<AgentIdentity> {
    return this.client.request(`/agents/${agentId}`)
  }
}

export class ResourcesClient {
  constructor(private readonly client: RequestTransport) {}

  /** Begin/complete a delegated connection. For Nango this kicks off the OAuth
   *  connect flow; the returned Resource never carries the underlying token. */
  async connect(name: string, opts: ResourceConnectOptions = {}): Promise<Resource> {
    return this.client.request('/resources', {
      method: 'POST',
      body: JSON.stringify({ name, ...opts })
    })
  }

  async revoke(resourceId: string): Promise<void> {
    await this.client.request(`/resources/${resourceId}/revoke`, { method: 'POST' })
  }
}

/**
 * Run-scoped authorization. Reachable as `ctx.auth` inside a workflow, exactly
 * like `ctx.gates` / `ctx.usage`. Every request is bound to the run, evaluated
 * against policy in run context, and recorded as a receipt on the run's events.
 */
export class RunAuth {
  constructor(
    private readonly client: RequestTransport,
    private readonly runId: string
  ) {}

  /**
   * Request a capability for a resource/action. Resolves to an active Grant once
   * policy passes (and any approval gate is approved). In proxy mode the grant
   * carries no token; call `use()` to proxy the action through Tidebase.
   *
   * This is the resolution of a step's declared `CredentialIntent` — see
   * StepOptions.credentials in the core SDK.
   */
  async request(req: GrantRequest): Promise<Grant> {
    return this.client.request(`/runs/${this.runId}/grants`, {
      method: 'POST',
      body: JSON.stringify(req)
    })
  }

  /** Proxy a call using a grant. The secret stays behind the boundary; Tidebase
   *  injects it into the upstream request and returns the upstream response. The
   *  agent sees the response, never the credential. Each use counts against maxUses. */
  async use(grantId: string, call: { method: string; path: string; body?: unknown }): Promise<GrantUseResult> {
    return this.client.request(`/runs/${this.runId}/grants/${grantId}/use`, {
      method: 'POST',
      body: JSON.stringify(call)
    })
  }

  async revoke(grantId: string): Promise<void> {
    await this.client.request(`/runs/${this.runId}/grants/${grantId}/revoke`, { method: 'POST' })
  }
}

export class AuditClient {
  constructor(private readonly client: RequestTransport) {}

  /** Reads grant.* receipts from the append-only event log. */
  async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const qs = new URLSearchParams()
    if (query.runId) qs.set('runId', query.runId)
    if (query.agentId) qs.set('agentId', query.agentId)
    if (query.resource) qs.set('resource', query.resource)
    if (query.types?.length) qs.set('types', query.types.join(','))
    if (query.limit) qs.set('limit', String(query.limit))
    return this.client.request(`/audit?${qs.toString()}`)
  }
}

// Re-export so call sites can resolve a step's declared credential intent into a grant.
export type { CapabilityIntent }

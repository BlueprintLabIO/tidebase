# Tidebase v0.7.0, Agent auth + credential broker

v0.7.0 ships the **agent auth control plane** and a **credential broker**: each agent gets its own identity, secrets live in a vault, and Tidebase makes the outbound call with the credential injected, so the agent and the LLM never see the key. This moves "credential brokering" out of the Not-In-This-Alpha list. Tidebase still does not run your code; your runtime stays yours.

## Server

- **Agent identity (keypair challenge/response).** `POST /agents` registers an agent (identity kinds: `dev_token`, `keypair`, `cloud_key`, `spire`). `POST /agents/:id/challenge` mints a stateless 60s HMAC challenge; `POST /agents/:id/prove` verifies an Ed25519 signature (challenge reuse blocked via `consumed_challenges`) and returns a short-lived (15m) session token. Per-agent identity, not a shared key.
- **Resources + vault.** `POST /resources` connects a third-party resource. `provider: static` vaults a supplied secret (envelope-encrypted at rest, AES-256-GCM with a KMS-wrapped DEK); `nango` / `openbao` delegate custody and hold only an opaque `connection_ref`. `baseUrl` pins the upstream (SSRF defense) and `scopesAllowed` caps any grant. The returned resource never carries the secret.
- **Run-bound grants + proxy.** `POST /runs/:id/grants` requests a capability for a resource+action; the policy engine evaluates it (deny-destructive, approval-sensitive, allow-standard) and picks `proxy` (secret stays behind the boundary) or `mint` (short-lived scoped token). `POST /runs/:id/grants/:gid/use` makes the real call with the credential injected (`bearer` / `header` / `basic`) and returns the upstream response. The secret is never returned to the caller or written to events. `revoke` ends a grant.
- **Audit ledger.** `GET /audit` returns grant receipts (agent / resource / type scoped), with no secret material.
- **SSRF defense.** Path-only proxying pinned to the resource origin; DNS-rebinding and private-IP / metadata-host blocks (`assertSafeTarget`), with a dev-only `TIDEBASE_ALLOW_PRIVATE_PROXY` escape hatch.
- **Product MCP server (`apps/mcp`).** Read-only operational tools over an existing Tidebase server: list runs, get a run (steps/gates/grants/timeline), read the grant audit, and approve a gate.

## Migrations

`003_agent_auth` (agents, agent_sessions, resources, grants), `004_run_grant_tenancy` (first-principal isolation), `005_custody_and_abuse_stores` (envelope-encrypted `resource_secrets`, rate limits, consumed challenges), `006_resource_path_scope` (per-resource allowed path prefix). Expand-only, applied by the existing migration runner under an advisory lock.

## SDKs (`@tidebase/sdk` 0.7.0, `tidebase` 0.7.0)

- `tide.agents`, `register` / `challenge` / `prove`.
- `tide.resources`, `connect(name, { provider, baseUrl, secret, scopesAllowed })` / `revoke`.
- `tide.auth(runId)` → a `RunAuth`: `request(req)` → a grant, `use(grantId, { method, path, body })` → the proxied response (secret never exposed), `revoke(grantId)`.
- `tide.audit.list(query)`, grant receipts.

## Verification

A new `apps/server/scripts/brokerDogfood.ts` exercises the whole path end to end over real HTTP: register an agent, prove, connect a static-secret resource, request a grant, and use it against a live upstream. It asserts the call actually happened, the secret was injected upstream, and the secret never appears in the resource/grant/use responses or the audit ledger. The server test suite (envelope encryption, providers, policy, SSRF, agent-auth, leases/heartbeat) passes alongside the existing run/queue/schedule coverage.

## Why

Agents that act on real services need three things that usually live in three different systems: an identity, somewhere to keep the secret, and something that makes the call without handing the secret to the model. v0.7 puts all three in the same Postgres-backed control plane you already run for checkpoints, queues, schedules, and gates. The closest hosted equivalent (Arcade) keeps its broker engine closed; the open alternatives are standalone proxies. Tidebase is the broker and the durable backbone in one place, on your own database.

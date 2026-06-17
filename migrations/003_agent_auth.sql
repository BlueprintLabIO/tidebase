-- v0.7: agent authentication & run-bound authorization (the auth control-plane layer).
-- Encodes the trust boundary:
--   SPIRE / identity provider  = proves WHAT the agent is        -> agents
--   OpenBao / Nango            = hold WHAT the agent might need   -> resources.connection_ref (opaque)
--   Tidebase                   = decides WHAT the agent may do now -> grants + policy + gates
-- Receipts ride on the existing append-only `events` log (type = 'grant.*'); no new audit table.
-- Expand-only: no destructive changes to existing rows or columns.

-- Agent identity registry. The agent proves identity via a pluggable provider;
-- `identity_kind` selects which. SPIRE is one possible kind, not a requirement.
create table if not exists agents (
  id text primary key default ('agent_' || replace(gen_random_uuid()::text, '-', '')),
  name text not null,
  principal text,                       -- owning user/org/tenant
  identity_kind text not null default 'dev_token',  -- dev_token | keypair | cloud_key | spire
  public_key text,                      -- for keypair/cloud_key providers
  spiffe_id text,                       -- only when identity_kind = 'spire'
  status text not null default 'active',-- active | disabled | revoked
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (principal, name)
);

create table if not exists agent_sessions (
  id text primary key default ('ags_' || replace(gen_random_uuid()::text, '-', '')),
  agent_id text not null references agents(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Connected third-party resources. `connection_ref` is an OPAQUE internal pointer
-- (Nango connectionId, OpenBao secret path, etc.). It is NEVER returned by the API.
create table if not exists resources (
  id text primary key default ('res_' || replace(gen_random_uuid()::text, '-', '')),
  principal text,                       -- owner; resources are delegated, not global
  name text not null,                   -- 'github', 'gmail', 'stripe', ...
  provider text not null,               -- nango | openbao | static
  kind text not null default 'oauth',   -- oauth | api_key | dynamic
  connection_ref text not null,         -- INTERNAL pointer to the held secret; never exposed
  scopes_allowed jsonb not null default '[]'::jsonb,  -- ceiling: grants cannot exceed this
  status text not null default 'connected',           -- connected | revoked | error
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (principal, name)
);

-- A minted, scoped, run-bound capability. The product surface of "what may this
-- agent do right now". Stores token_hash, never the token. `mode`:
--   mint  -> a short-lived scoped credential is handed to the agent
--   proxy -> the secret never leaves the boundary; Tidebase makes the call (default for high-sensitivity)
create table if not exists grants (
  id text primary key default ('grant_' || replace(gen_random_uuid()::text, '-', '')),
  run_id text not null references runs(id) on delete cascade,
  step_id text references steps(id) on delete set null,
  agent_id text references agents(id) on delete set null,
  resource_id text references resources(id) on delete set null,
  resource text not null,               -- requested target, e.g. 'github:repo:acme/app'
  action text not null,                 -- e.g. 'pull_request.create'
  scopes jsonb not null default '[]'::jsonb,
  reason text,
  mode text not null default 'proxy',   -- proxy | mint
  status text not null default 'pending', -- pending | approved | active | denied | expired | revoked | used
  gate_id text references gates(id) on delete set null,  -- approval gate, when policy requires one
  token_hash text,                      -- hash of the short-lived grant token (mint mode only)
  max_uses integer not null default 1,
  used_count integer not null default 0,
  ttl_seconds integer not null default 120,
  policy_json jsonb not null default '{}'::jsonb,  -- snapshot of the policy decision (for replay/audit)
  issued_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agents_principal_idx on agents(principal);
create index if not exists agent_sessions_agent_id_idx on agent_sessions(agent_id);
create index if not exists agent_sessions_expires_at_idx on agent_sessions(expires_at) where revoked_at is null;
create index if not exists resources_principal_idx on resources(principal);
create index if not exists grants_run_id_idx on grants(run_id);
create index if not exists grants_agent_id_idx on grants(agent_id);
create index if not exists grants_status_idx on grants(status);
create index if not exists grants_expires_at_idx on grants(expires_at) where status in ('active','approved');

do $$
begin
  alter table agents add constraint agents_identity_kind_check
    check (identity_kind in ('dev_token','keypair','cloud_key','spire'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table agents add constraint agents_status_check
    check (status in ('active','disabled','revoked'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table resources add constraint resources_provider_check
    check (provider in ('nango','openbao','static'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table resources add constraint resources_kind_check
    check (kind in ('oauth','api_key','dynamic'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table resources add constraint resources_status_check
    check (status in ('connected','revoked','error'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table grants add constraint grants_mode_check
    check (mode in ('proxy','mint'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table grants add constraint grants_status_check
    check (status in ('pending','approved','active','denied','expired','revoked','used'));
exception when duplicate_object then null;
end $$;

-- Receipts are events, not a new table. Canonical types emitted on the run:
--   grant.requested, grant.approved, grant.denied, grant.minted, grant.used, grant.revoked, grant.expired
-- Payloads carry grant_id / resource / action / agent_id and NEVER the secret or token.

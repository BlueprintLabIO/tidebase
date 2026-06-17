-- v0.7: real credential custody + multi-replica abuse stores.
--   resource_secrets : envelope-encrypted credential material (never plaintext)
--   resources.base_url : upstream API base the proxy is pinned to (SSRF defense)
--   rate_limits       : shared fixed-window limiter (replaces per-process map)
--   consumed_challenges : shared keypair-challenge replay cache (multi-replica)
-- Expand-only.

alter table resources add column if not exists base_url text;

create table if not exists resource_secrets (
  resource_id text primary key references resources(id) on delete cascade,
  material_json jsonb not null,   -- AES-256-GCM envelope; ciphertext + wrapped DEK only
  key_id text not null,           -- which KEK wrapped the DEK (rotation)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  count integer not null default 0
);
create index if not exists rate_limits_window_idx on rate_limits(window_start);

create table if not exists consumed_challenges (
  challenge_hash text primary key,
  expires_at timestamptz not null
);
create index if not exists consumed_challenges_expires_idx on consumed_challenges(expires_at);

create extension if not exists pgcrypto;

create table if not exists runs (
  id text primary key default ('run_' || replace(gen_random_uuid()::text, '-', '')),
  workflow_name text not null,
  input_json jsonb not null default '{}'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  result_json jsonb,
  error_json jsonb,
  recovery_webhook text,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists steps (
  id text primary key default ('step_' || replace(gen_random_uuid()::text, '-', '')),
  run_id text not null references runs(id) on delete cascade,
  name text not null,
  input_hash text not null,
  input_json jsonb not null default '{}'::jsonb,
  options_json jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  output_json jsonb,
  error_json jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, name)
);

create table if not exists events (
  id bigserial primary key,
  run_id text not null references runs(id) on delete cascade,
  seq bigint not null,
  type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create table if not exists run_state (
  run_id text primary key references runs(id) on delete cascade,
  value_json jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists recovery_attempts (
  id text primary key default ('rec_' || replace(gen_random_uuid()::text, '-', '')),
  run_id text not null references runs(id) on delete cascade,
  reason text not null,
  webhook_url text not null,
  status text not null default 'pending',
  http_status integer,
  response_body text,
  error_text text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists runs_status_idx on runs(status);
create index if not exists steps_run_id_idx on steps(run_id);
create index if not exists events_run_id_seq_idx on events(run_id, seq);
create index if not exists recovery_attempts_run_id_idx on recovery_attempts(run_id);

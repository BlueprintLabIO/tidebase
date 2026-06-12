-- v0.5: authoritative lifecycle (cancellation, deadlines, failure class),
-- queue primitives (dedupe, delay, attempts, claims), and cron schedules.
-- Expand-only: no destructive changes to existing rows or columns.

alter table runs add column if not exists queue_name text;
alter table runs add column if not exists dedupe_key text;
alter table runs add column if not exists priority integer not null default 0;
alter table runs add column if not exists run_at timestamptz;
alter table runs add column if not exists max_attempts integer not null default 1;
alter table runs add column if not exists claimed_at timestamptz;
alter table runs add column if not exists deadline_at timestamptz;
alter table runs add column if not exists cancel_requested_at timestamptz;
alter table runs add column if not exists cancelled_at timestamptz;
alter table runs add column if not exists cancel_reason text;
alter table runs add column if not exists cancel_actor text;
alter table runs add column if not exists failure_class text;

-- Dedupe: at most one active run per (queue, dedupe key). Terminal runs free
-- the key, so "active dedupe" semantics match DBOS/pg-boss expectations.
create unique index if not exists runs_queue_dedupe_active
  on runs (queue_name, dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');

create index if not exists runs_queue_claim
  on runs (queue_name, status, run_at, priority)
  where queue_name is not null;

create index if not exists runs_lease_expiry
  on runs (lease_expires_at)
  where status = 'running';

create table if not exists queue_configs (
  name text primary key,
  concurrency integer,
  rate_per_minute integer,
  invoke_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists schedules (
  name text primary key,
  cron text not null,
  workflow_name text not null,
  input_json jsonb not null default '{}'::jsonb,
  queue_name text not null default 'default',
  max_attempts integer not null default 1,
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_enqueued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

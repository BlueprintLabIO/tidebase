-- v0.7: run-level tenancy for grants. A run is "claimed" by the first agent
-- principal that requests a grant on it (trust-on-first-use); subsequent grant
-- requests from a different principal are rejected. This isolates credential
-- brokering across tenants even though runs are created by the operator key
-- without a principal. Expand-only.
alter table runs add column if not exists grant_principal text;
create index if not exists runs_grant_principal_idx on runs(grant_principal) where grant_principal is not null;

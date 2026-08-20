-- Construction Budget activity log (2026-08-20, Seni's ask: "add an
-- activity log button here too... so that we can monitor who entered what
-- on this screen") — mirrors construction_activity_log's shape/purpose
-- (see 0042_construction.sql) but is its own table since budget line items
-- live in a separate table (construction_budget_items) with a separate
-- lifecycle (import/replace rather than create/complete/delete).
create table if not exists construction_budget_activity_log (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null default 'legacy-colombia',

  -- Null for a whole-budget "imported" entry (no single row to point at).
  item_id uuid,
  item_description text,

  action text not null, -- 'imported' | 'updated' | 'deleted'
  detail text,          -- e.g. "142 line items" or "Actual set to $1,200"

  actor_email text not null,
  actor_name text,
  at timestamptz not null default now()
);

create index if not exists construction_budget_activity_log_org_idx
  on construction_budget_activity_log (organization_id, property_group_id, at desc);

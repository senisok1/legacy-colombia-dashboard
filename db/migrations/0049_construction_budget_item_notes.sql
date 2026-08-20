-- Per-item notes thread on Construction Budget (2026-08-20, Seni's ask: "add
-- a notes button for each item in the budget for any user to add notes").
-- Mirrors construction_item_notes (Construction Management's Progress Notes
-- thread) — an append-only conversation about ONE budget line item, separate
-- from construction_budget_items.notes (the single free-text field editable
-- alongside Actual USD). Open to any viewer of this tab (CEO or CONSTRUCTION
-- role), not Seni-restricted like import/delete/FX-rate — enforced by the
-- caller, see api/construction-budget/notes/route.ts.
create table if not exists construction_budget_item_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null default 'legacy-colombia',
  item_id uuid not null references construction_budget_items(id) on delete cascade,

  body text not null,
  author_email text not null,
  author_name text,

  created_at timestamptz not null default now()
);

create index if not exists construction_budget_item_notes_item_idx
  on construction_budget_item_notes (item_id, created_at);

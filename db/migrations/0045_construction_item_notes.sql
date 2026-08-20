-- Per-item notes thread on Construction Management (2026-08-20, Seni's ask):
-- "add a notes section under each item that needs to be fixed so that the
-- construction team can put in notes on how it was fixed or that it wasn't
-- fixed and what they need to do next." Append-only progress log, separate
-- from construction_items.notes (the single free-text field set when an item
-- is first created) and from construction_activity_log (the structured
-- created/completed/reopened/deleted trail) — this is an ongoing, multi-entry
-- conversation about ONE item's status over time.
create table if not exists construction_item_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null default 'legacy-colombia',
  item_id uuid not null references construction_items(id) on delete cascade,

  body text not null,
  author_email text not null,
  author_name text,

  created_at timestamptz not null default now()
);

create index if not exists construction_item_notes_item_idx
  on construction_item_notes (item_id, created_at);

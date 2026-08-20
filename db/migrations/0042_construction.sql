-- Construction Management tab (2026-08-20, Seni's ask): a new tab, hidden
-- on every property except Legacy Colombia for now (same nav-level gating
-- pattern as Commissions — see NavBar.tsx), visible only to admin/owner
-- (CEO) logins plus a brand-new restricted login type for the construction
-- team itself, who can see NOTHING ELSE (enforced in src/proxy.ts). An open
-- items checklist: anyone with access can add an item and check it off;
-- every add/complete/reopen/delete is recorded in a companion activity log
-- so there's always a "who did what" trail, same spirit as team_activities
-- (0021) but its own tables since this isn't part of the Team
-- Management/READ_ONLY surface at all.

-- New login type. Existing enum (0001_init.sql) already has unused
-- placeholders (LOCAL_MANAGER, MAINTENANCE_STAFF, etc.) from the original
-- Phase 1 design that were never wired to any actual gating — CONSTRUCTION
-- is a fresh, explicitly-gated value rather than repurposing one of those,
-- so it's unambiguous in code and in the settings UI. Safe to run inside
-- migrate.mjs's transaction: the new value isn't used by anything else in
-- this same file/transaction.
do $$ begin
  alter type role add value if not exists 'CONSTRUCTION';
exception when duplicate_object then null; end $$;

create table if not exists construction_items (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  -- Every row is stamped Legacy Colombia today (the only property this tab
  -- is enabled for), but stored per-row rather than assumed so the feature
  -- can be turned on for another property later without a schema change.
  property_group_id text not null default 'legacy-colombia',

  title text not null,
  notes text,

  completed boolean not null default false,
  completed_by_email text,
  completed_by_name text,
  completed_at timestamptz,

  created_by_email text not null,
  created_by_name text,
  created_at timestamptz not null default now()
);

create index if not exists construction_items_org_idx
  on construction_items (organization_id, property_group_id, completed, created_at desc);

-- Separate from construction_items so a deleted item's history survives the
-- delete (item_title is a snapshot, item_id may point at a since-removed
-- row) — same reasoning as keeping attribution denormalized throughout this
-- app (team_activities, expense_requests, team_requests).
create table if not exists construction_activity_log (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null default 'legacy-colombia',
  item_id uuid,
  item_title text not null,
  -- 'created' | 'completed' | 'reopened' | 'deleted'
  action text not null,
  actor_email text not null,
  actor_name text,
  at timestamptz not null default now()
);

create index if not exists construction_activity_log_org_idx
  on construction_activity_log (organization_id, property_group_id, at desc);

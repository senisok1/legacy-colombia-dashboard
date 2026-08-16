-- Per-stay ops flags for the Management tab (2026-08-16, Seni's ask):
-- whether a paid event (wedding, party...) is scheduled during the stay,
-- and on which date. Writable by every role including READ_ONLY team
-- logins (allowlisted in src/proxy.ts) — this is on-site coordination
-- data, not guest-facing.
create table if not exists booking_ops (
  organization_id text not null references organizations(id) on delete cascade,
  booking_id bigint not null,
  event_scheduled boolean not null default false,
  event_date date,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (organization_id, booking_id)
);

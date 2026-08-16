-- Management tab (2026-08-16, Seni's ask): a central place where the
-- on-site team (cleaners, property manager, etc. — logging in with the
-- READ_ONLY role) can see upcoming stays and log their own activities and
-- per-booking ops notes (paid-extras requests, wedding/event flags, etc.).
-- This is the ONE table a READ_ONLY session is allowed to write to — see
-- src/proxy.ts's role gate.
create table if not exists team_activities (
  id uuid primary key default gen_random_uuid(),
  -- organizations.id is TEXT (uuid-shaped strings) — see 0015.
  organization_id text not null references organizations(id) on delete cascade,
  -- Optional link to an OwnerRez booking id: entries with a booking_id are
  -- per-stay ops notes (shown on that stay's card); entries without one are
  -- general team-activity log entries.
  booking_id bigint,
  author_email text not null,
  author_name text,
  -- 'note' (per-booking ops note) | 'activity' (team log entry)
  kind text not null default 'activity',
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_team_activities_org_created
  on team_activities (organization_id, created_at desc);
create index if not exists idx_team_activities_org_booking
  on team_activities (organization_id, booking_id);

-- Team Request Notes (2026-08-18, Seni's ask: "add a notes section where
-- each team member can put in their notes back and forth" under Team
-- Activity Log's "Requests needing accept or deny"). A lightweight threaded
-- discussion per request — separate from team_activities (the general
-- free-text feed keyed to a bookingId) since these are keyed to a
-- team_requests row and rendered together with that request's own card.
--
-- Attribution stays DENORMALIZED (email + name at write time), same
-- convention as team_requests/team_activities, so a note still reads
-- correctly if that login is later deleted. on delete cascade on request_id
-- means a request's notes go with it if the request itself is removed
-- (deleteTeamRequest in lib/teamRequests.ts).

create table if not exists team_request_notes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references team_requests(id) on delete cascade,
  organization_id text not null references organizations(id) on delete cascade,

  author_email text not null,
  author_name text,

  -- Always English; body_original holds what a Spanish/Portuguese teammate
  -- actually typed (same scheme as team_requests.description).
  body text not null,
  body_original text,
  author_language text,

  created_at timestamptz not null default now()
);

-- Powers "load every note for these requests in one query, oldest first"
-- (api/team-requests/route.ts's GET).
create index if not exists team_request_notes_request_idx
  on team_request_notes (request_id, created_at asc);

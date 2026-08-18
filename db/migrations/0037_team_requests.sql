-- Team Requests (2026-08-18, Seni's ask: "add an activity under the Team
-- Activity Log tab like 'tour guide requested on August 25th, please accept
-- or deny' — tag someone from the team to accept or deny it, notified by
-- email/WhatsApp"). Same lifecycle shape as expense_requests
-- (0028_expense_requests.sql) — a requester describes what's needed and tags
-- one teammate, the tagged person accepts or declines (from the dashboard OR
-- by replying YES/NO on WhatsApp — see lib/teamRequests.ts), and the
-- requester is notified of the outcome. "Completed" is optional bookkeeping
-- for after acceptance, same as expense requests' completion step.
--
-- Attribution stays DENORMALIZED (email + name at the time of the action),
-- same pattern as team_activities/expense_requests, so a request keeps
-- reading correctly even if a login involved is later deleted.

create table if not exists team_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text,

  title text not null,
  -- Always English; description_original holds what a Spanish/Portuguese
  -- teammate actually typed (same scheme as team_activities/expense_requests).
  description text,
  description_original text,
  author_language text,

  needed_by date,

  requested_by_email text not null,
  requested_by_name text,
  requested_at timestamptz not null default now(),

  -- The one teammate asked to accept/deny this. Denormalized (not an FK) so
  -- the request stays readable if that login is later deleted — see
  -- lib/teamRequests.ts for how inbound WhatsApp replies re-resolve the
  -- LIVE user row by phone at reply time instead of trusting this snapshot.
  tagged_email text not null,
  tagged_name text,

  -- wamid of the "please accept or deny" WhatsApp message sent to the tagged
  -- person, so a swipe-to-reply YES/NO resolves to exactly this request (same
  -- convention as pendingDrafts.wamid). Null until that send succeeds.
  notify_wamid text,

  accepted boolean not null default false,
  declined boolean not null default false,
  decided_by_email text,
  decided_by_name text,
  decided_at timestamptz,
  decline_reason text,

  completed boolean not null default false,
  completed_by_email text,
  completed_by_name text,
  completed_at timestamptz
);

create index if not exists team_requests_org_idx
  on team_requests (organization_id, requested_at desc);

-- Powers "does this tagged person have anything pending" — both the
-- dashboard badge and the WhatsApp-reply fallback (no context wamid) use it.
create index if not exists team_requests_tagged_pending_idx
  on team_requests (organization_id, tagged_email, accepted, declined);

create index if not exists team_requests_wamid_idx
  on team_requests (notify_wamid) where notify_wamid is not null;

-- Team members' WhatsApp numbers (2026-08-18, Seni's ask: "make whatsapp
-- number a mandatory field when adding a team member moving forward").
-- Nullable at the column level on purpose — existing logins predate this and
-- must not break — the REQUIRED rule for new logins is enforced in
-- api/settings/users/route.ts, not the schema. E.164-ish free text (not a
-- strict format), same posture as OwnerRez guest phone numbers elsewhere in
-- this app.
alter table users add column if not exists whatsapp_phone text;

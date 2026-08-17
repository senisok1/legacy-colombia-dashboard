-- Team Expense Requests (2026-08-17, Seni's ask: "allow any team member to
-- request an expense with clear details on what it is, how much it will
-- cost … log who requested it and the date and time … add an owner approved
-- checkbox that only admin owner users can check off … and a completed tab
-- which will also log the date completed").
--
-- Replaces the old Maintenance work-order tab in the nav. Attribution is
-- stored DENORMALIZED (email + display name at the time of the action), same
-- pattern as team_activities: a request keeps showing who asked for it even
-- if that login is later deleted.

create table if not exists expense_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  -- Property view this request belongs to (src/lib/propertyGroups.ts id).
  property_group_id text,

  title text not null,
  -- Always English; description_original holds what a Spanish/Portuguese
  -- teammate actually typed, so the owner reads English and the author
  -- rereads their own words (same scheme as team_activities).
  description text,
  description_original text,
  author_language text,

  category text not null default 'other',
  estimated_amount numeric(12, 2),
  currency text not null default 'USD',
  -- Where they'd buy it / which vendor, free text.
  vendor text,
  -- 'low' | 'normal' | 'urgent'
  urgency text not null default 'normal',
  -- Date they need it by, 'YYYY-MM-DD'.
  needed_by date,
  -- Optional link to a quote, photo, or listing.
  reference_url text,

  requested_by_email text not null,
  requested_by_name text,
  requested_at timestamptz not null default now(),

  -- Owner approval. Only a CEO login may set these (enforced in the route).
  approved boolean not null default false,
  approved_by_email text,
  approved_by_name text,
  approved_at timestamptz,
  -- Set instead of approved when the owner turns the request down.
  declined boolean not null default false,
  declined_reason text,

  completed boolean not null default false,
  completed_by_email text,
  completed_by_name text,
  completed_at timestamptz,
  -- What it actually cost, filled in when marking it done.
  actual_amount numeric(12, 2)
);

create index if not exists expense_requests_org_idx
  on expense_requests (organization_id, requested_at desc);

create index if not exists expense_requests_status_idx
  on expense_requests (organization_id, completed, approved);

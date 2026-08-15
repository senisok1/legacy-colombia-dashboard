-- Agent #9 of the Legacy AI Company roadmap (see docs/VISION.md) —
-- Reputation Manager. Seni explicitly chose "queue AI-drafted responses for
-- WhatsApp/dashboard approval, never auto-post" as the scope for this first
-- build (2026-08-01), matching every other agent in this app: nothing
-- public-facing or irreversible happens without a human clicking approve
-- first (see Bill Pay's "no paid_by_ai state" and Guest Experience's
-- WhatsApp-approval pattern for the precedent this follows).
--
-- Reviews themselves are NOT stored here — lib/ownerrez.ts's getReviews()
-- already reads them live from OwnerRez (which aggregates Airbnb/Vrbo/etc
-- automatically), so there's no need to duplicate/sync that data. This table
-- only tracks the one thing OwnerRez's API can't: the draft response and
-- Seni's decision on it. Confirmed 2026-08-01 against OwnerRez's own
-- published OpenAPI spec (api.ownerrez.com/openapi/v2.json) that /v2/reviews
-- only supports GET, not a write method — so even an "approved" response
-- can't be posted through this app's API calls. OwnerRez's own dashboard UI
-- (Quality Center > Reviews) DOES support responding, and that response
-- syncs back to the original OTA automatically (confirmed via OwnerRez's own
-- support docs) — so "approved" here means "ready for Seni to copy into
-- OwnerRez himself," not "sent." review_source/review_rating/guest_name/
-- review_created_at are denormalized copies of the review at draft time
-- purely for display/sorting without needing an extra live OwnerRez call
-- every time this table is queried.
--
-- Applied via GET /api/admin/migrate?secret=... (see project memory on why
-- DATABASE_URL can't be pulled into this sandbox directly).

do $$ begin
  create type reputation_response_status as enum (
    'pending_review',  -- AI drafted a response, awaiting Seni's decision
    'approved',        -- Seni approved (possibly after editing draft_text) — ready to copy into OwnerRez
    'rejected',        -- Seni decided not to respond to this review at all
    'posted'           -- Seni confirms he copied the approved text into OwnerRez himself
  );
exception when duplicate_object then null; end $$;

create table if not exists reputation_responses (
  id text primary key default gen_random_uuid()::text,
  property_id text references properties(id),
  -- OwnerRez's own review id — plain integer, not a foreign key, since
  -- reviews live in OwnerRez, not this database (same convention as
  -- leads.guest_id / work_orders.booking_id).
  review_id integer not null,
  review_source text not null,
  review_rating integer,
  guest_name text,
  review_created_at timestamptz,
  -- Denormalized snapshot of the comment at draft time, so the Reputation
  -- tab and any historical audit don't depend on OwnerRez still returning
  -- the exact same text later (reviews can theoretically be edited/removed
  -- upstream).
  review_comment text,
  draft_text text not null,
  status reputation_response_status not null default 'pending_review',
  decided_at timestamptz,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per review — re-running detection finds the existing row
  -- instead of drafting a duplicate.
  unique (property_id, review_id)
);
create index if not exists reputation_responses_status_idx on reputation_responses(status);
create index if not exists reputation_responses_review_rating_idx on reputation_responses(review_rating);

-- Registers the agent so ai_activity_log entries have somewhere to attach.
insert into agents (key, display_name, description, mode)
values (
  'reputation_manager',
  'AI Reputation Manager',
  'Drafts responses to guest reviews for Seni''s approval. Never posts publicly — OwnerRez''s API has no write endpoint for reviews, and even once it did this app would still queue for approval first, matching every other public-facing action in this system.',
  'SHADOW'
)
on conflict (key) do nothing;

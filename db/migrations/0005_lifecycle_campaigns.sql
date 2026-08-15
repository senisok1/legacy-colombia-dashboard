-- Phase 6 (second half) of the Legacy AI Company roadmap (see docs/VISION.md)
-- — CRM & Lifecycle Marketing half of "Sales + CRM lifecycle marketing". The
-- Sales Pipeline half (leads table, 0004_sales_pipeline.sql) tracks inbound
-- inquiries; this half tracks OUTBOUND, proactive re-engagement of guests who
-- already exist in OwnerRez: win-back (past guests who haven't rebooked),
-- referral (recent happy guests, asked to send friends/family our way), and
-- abandoned-booking (an OwnerRez Inquiry/Quote/Hold that went stale and never
-- converted).
--
-- Deliberately NOT included in v1: a "birthday" campaign. OwnerRez's guest
-- record has no birthdate field (see src/lib/types.ts's Guest type), and
-- this migration doesn't invent one — building a whole manual-entry UI for
-- guest birthdates was judged out of scope for this pass. The enum below
-- leaves room to add 'birthday' later once there's an actual data source.
--
-- Guardrails this schema enforces (see VISION.md's "guardrails that apply to
-- every agent, always" + the CRM & Lifecycle Marketing Manager's spec):
--   - Every row starts life as a 'candidate' — nothing is ever sent without
--     Seni explicitly approving that exact row (see lib/lifecycleMarketing.ts).
--   - No discount amount, promo code, or specific incentive is stored or
--     promised anywhere here — the AI-drafted message is instructed to keep
--     any referral "ask" soft (no specific %, no code) since no incentive
--     program has been configured/approved yet.
--   - guest_marketing_preferences lets Seni permanently suppress a specific
--     guest from ever being suggested again (consent/opt-out tracking, per
--     VISION.md's CRM & Lifecycle Marketing Manager spec).
--
-- Applied via GET /api/admin/migrate?secret=... (see that route's comment
-- for why — Sensitive DATABASE_URL can't be pulled locally on this project).

do $$ begin
  create type lifecycle_campaign_type as enum (
    'win_back', 'referral', 'abandoned_booking'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type lifecycle_campaign_status as enum (
    'candidate', 'approved', 'sent', 'skipped', 'failed', 'opted_out'
  );
exception when duplicate_object then null; end $$;

create table if not exists lifecycle_campaign_candidates (
  id text primary key default gen_random_uuid()::text,
  campaign_type lifecycle_campaign_type not null,
  -- Plain OwnerRez integer ids (not foreign keys) — guests/bookings live in
  -- OwnerRez, not this database. Same convention as leads.guest_id.
  guest_id integer,
  guest_name text not null,
  guest_email text,
  guest_phone text,
  -- The "anchor" booking: the abandoned Inquiry/Quote/Hold itself for
  -- abandoned_booking, or the guest's most recent completed stay for
  -- win_back/referral.
  booking_id integer,
  -- The OwnerRez message thread this would be sent into, if one exists —
  -- sending requires posting into an existing thread (see lib/ownerrez.ts's
  -- sendMessage; there is no channel in this app for messaging a guest's
  -- raw phone/email directly, only through OwnerRez's own thread system so
  -- it's delivered via whatever channel the guest originally used).
  thread_id integer,
  -- Human-readable reason a human reviewing this candidate can trust at a
  -- glance, e.g. "Last stayed 2025-02-14, hasn't rebooked since (14 months)."
  trigger_reason text not null,
  draft_message text not null,
  draft_message_english text,
  language text,
  status lifecycle_campaign_status not null default 'candidate',
  -- Populated if an approved send actually failed (e.g. the OwnerRez thread
  -- is closed/archived) — surfaced to Seni rather than silently swallowed.
  send_error text,
  sent_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lifecycle_campaign_candidates_status_idx on lifecycle_campaign_candidates(status);
create index if not exists lifecycle_campaign_candidates_type_idx on lifecycle_campaign_candidates(campaign_type);
create index if not exists lifecycle_campaign_candidates_guest_id_idx on lifecycle_campaign_candidates(guest_id);

-- One row per guest who has ever been opted out of lifecycle marketing
-- outreach. Absence of a row = eligible (implicit consent from being a past
-- guest, standard vacation-rental practice) — this table only ever grows by
-- Seni explicitly opting someone out, never automatically.
create table if not exists guest_marketing_preferences (
  guest_id integer primary key,
  opted_out boolean not null default false,
  reason text,
  updated_at timestamptz not null default now()
);

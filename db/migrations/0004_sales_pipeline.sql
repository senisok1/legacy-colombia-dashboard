-- Phase 6 of the Legacy AI Company roadmap (see docs/VISION.md) — Sales
-- Pipeline half of "Sales + CRM lifecycle marketing". Tracks inquiries that
-- haven't (yet) turned into an OwnerRez booking through the stages VISION.md
-- specifies for the Sales Agent: new -> contacted -> qualified -> proposal ->
-- deposit -> booked/lost/nurture.
--
-- Deliberately NOT a copy of OwnerRez's own Inquiry/Quote booking statuses
-- (see src/lib/types.ts's BookingStatus) — those already exist and this
-- table doesn't duplicate them. A lead here can optionally reference an
-- OwnerRez guest/booking once one exists (guest_id/booking_id, following the
-- same "store the OwnerRez integer id, not a local copy of the record"
-- convention as guest_notes/message_log in 0001_init.sql), but a lead can
-- also exist entirely on its own — e.g. a DM or phone call that hasn't been
-- entered into OwnerRez at all yet. No money movement or guest-facing send
-- lives in this table or lib/leads.ts; this is a tracking/prioritization
-- surface only, matching the same "observe and log before automating"
-- posture as every other phase in VISION.md.
--
-- Applied via GET /api/admin/migrate?secret=... (see that route's comment
-- for why — Sensitive DATABASE_URL can't be pulled locally on this project).

do $$ begin
  create type lead_stage as enum (
    'new', 'contacted', 'qualified', 'proposal', 'deposit', 'booked', 'lost', 'nurture'
  );
exception when duplicate_object then null; end $$;

create table if not exists leads (
  id text primary key default gen_random_uuid()::text,
  -- Optional link to an existing OwnerRez guest/booking once one exists.
  -- Plain integers (not foreign keys) since guests/bookings live in
  -- OwnerRez, not this database — same convention as guest_notes.guest_id.
  guest_id integer,
  booking_id integer,
  property_id text references properties(id),
  guest_name text not null,
  contact_email text,
  contact_phone text,
  -- Where the inquiry came from — free text so it can reflect however the
  -- lead actually arrived (WhatsApp, Instagram DM, phone call, OwnerRez
  -- inquiry form, referral, walk-in, etc.) without a rigid enum.
  source text not null default 'manual',
  stage lead_stage not null default 'new',
  desired_arrival date,
  desired_departure date,
  party_size integer,
  estimated_value_cents integer,
  notes text,
  next_action text,
  next_action_due_at timestamptz,
  last_contacted_at timestamptz,
  -- Only meaningful when stage = 'lost' — why it didn't convert (price,
  -- dates unavailable, went with a competitor, went cold, etc.), so losses
  -- are analyzable later rather than just disappearing from the board.
  lost_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leads_stage_idx on leads(stage);
create index if not exists leads_next_action_due_at_idx on leads(next_action_due_at);
create index if not exists leads_guest_id_idx on leads(guest_id);

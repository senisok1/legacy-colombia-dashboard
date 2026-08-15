-- Phase 3 gap of the Legacy AI Company roadmap (see docs/VISION.md) —
-- "Guest Experience + Maintenance" was originally scoped to include a real
-- Maintenance Manager (work orders, tracking, cost/root-cause logging), but
-- only Guest Experience shipped at the time; the maintenance half stayed at
-- a single one-shot "notify Gabriel via WhatsApp" ping with nothing
-- persisted anywhere (see src/lib/serviceRequestNotify.ts's original header
-- comment). This migration builds the missing tracking layer so every
-- reported issue — guest-flagged or manually logged — has a real lifecycle
-- Seni (and eventually the AI Maintenance Manager agent) can see and act on.
--
-- Deliberately reuses the `vendors` table from 0002_bill_pay.sql for
-- assignment rather than inventing a parallel contractor list — a plumber
-- who gets paid through Bill Pay is the same plumber who gets assigned a
-- work order here. Money still never moves from this table: cost_cents is
-- record-keeping only (what a repair ended up costing, filled in on
-- resolution), not a payment instruction — matching VISION.md's guardrail
-- that a maintenance issue becoming a bill is a separate, human-initiated
-- step in Bill Pay, not something this table triggers automatically.
--
-- Applied via GET /api/admin/migrate?secret=... or the temporary
-- /api/debug/run-migration route (see project memory on why DATABASE_URL
-- can't be pulled into this sandbox directly).

do $$ begin
  create type work_order_status as enum (
    'open',         -- reported, nobody has started yet
    'in_progress',  -- actively being worked
    'blocked',      -- waiting on a part, vendor availability, guest access, etc.
    'resolved',     -- fixed — cost/root_cause/resolution_notes expected to be filled in
    'cancelled'     -- turned out not to be a real issue, duplicate, or no longer needed
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type work_order_priority as enum (
    'low', 'normal', 'urgent',
    -- Matches VISION.md's Maintenance Manager guardrail: emergencies
    -- escalate immediately to Seni + local manager. No code path
    -- auto-assigns this priority yet (nothing here pages anyone) — it
    -- exists so the UI can flag it distinctly and a future escalation
    -- automation has somewhere to hook in.
    'emergency'
  );
exception when duplicate_object then null; end $$;

create table if not exists work_orders (
  id text primary key default gen_random_uuid()::text,
  property_id text references properties(id),
  -- Plain OwnerRez integers, not foreign keys — guests/bookings live in
  -- OwnerRez, not this database. Same convention as leads.guest_id /
  -- guest_notes.guest_id. threadId links back to the OwnerRez message
  -- thread this issue was reported in, when it came from a guest message.
  guest_id integer,
  booking_id integer,
  thread_id integer,
  title text not null,
  description text,
  -- Free text, not an enum — plumbing/electrical/pool/appliance/pest/hvac/
  -- other, but deliberately open-ended like leads.source and bills.category
  -- rather than a rigid list that needs a migration every time a new kind
  -- of issue comes up.
  category text,
  -- Where/who this came from — 'guest_message' (auto-created alongside the
  -- Gabriel notify when a guest reports something), 'manual' (Seni logs it
  -- himself), or 'inspection'/'vendor'/etc. as free text.
  source text not null default 'manual',
  reported_by text,
  priority work_order_priority not null default 'normal',
  status work_order_status not null default 'open',
  assigned_vendor_id text references vendors(id),
  -- Only meaningful once status = 'resolved' — what it cost (record-keeping
  -- only, see header comment), why it happened, and what was actually done.
  cost_cents integer,
  root_cause text,
  resolution_notes text,
  -- Set the first time notifyGabrielIfServiceRequest actually reaches Gabriel
  -- for THIS work order, so the UI can show "Gabriel was notified" without
  -- guessing from source = 'guest_message' alone (some guest reports never
  -- get to Gabriel, e.g. config missing or the send fails).
  gabriel_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists work_orders_status_idx on work_orders(status);
create index if not exists work_orders_priority_idx on work_orders(priority);
create index if not exists work_orders_guest_id_idx on work_orders(guest_id);
create index if not exists work_orders_assigned_vendor_id_idx on work_orders(assigned_vendor_id);

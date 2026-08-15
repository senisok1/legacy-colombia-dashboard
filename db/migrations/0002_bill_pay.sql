-- Phase 4 of the Legacy AI Company roadmap (see docs/VISION.md) — Bill Pay +
-- Vendor management, TRACKING/DETECTION ONLY. There is deliberately no
-- "paid_by_ai" status and no column or table anywhere in this migration that
-- represents an executed payment or a stored payment credential — per
-- VISION.md's guardrails, money movement stays fully manual (Seni pays
-- outside this system, then marks a bill "paid_manually" here for record-
-- keeping) until tracking/detection has a proven track record and Seni turns
-- payment scheduling on in a future phase.
--
-- Applied the same way as 0001_init.sql: GET /api/admin/migrate?secret=...
-- (see that route's comment for why — Sensitive DATABASE_URL can't be pulled
-- locally on this project).

do $$ begin
  create type bill_status as enum (
    'pending_review',      -- just entered, not yet looked at
    'flagged_duplicate',   -- matches an existing bill closely enough to be suspicious
    'flagged_anomaly',     -- unusual amount/vendor/timing, needs a human look
    'approved_for_payment',-- Seni has reviewed and greenlit it — still not paid by this system
    'paid_manually',       -- Seni paid it himself (bank/check/etc.) and logged it here
    'rejected'             -- not a real/valid bill, or a true duplicate — won't be paid
  );
exception when duplicate_object then null; end $$;

create table if not exists vendors (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  category text,
  contact_name text,
  contact_email text,
  contact_phone text,
  -- Free-text reference only (e.g. "Bancolombia, acct ending 4821") — NEVER
  -- treated as authoritative for actually sending money, and never populated
  -- automatically from an email/message per VISION.md's explicit warning
  -- that payment-instruction changes must be independently verified, never
  -- trusted from email alone. This field exists purely so a human reviewing
  -- a bill has context; no code path in this app reads it to move money.
  payment_notes text,
  default_property_id text references properties(id),
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vendors_active_idx on vendors(active);

create table if not exists bills (
  id text primary key default gen_random_uuid()::text,
  vendor_id text not null references vendors(id),
  property_id text references properties(id),
  invoice_number text,
  amount_cents integer not null,
  currency text not null default 'USD',
  category text,
  invoice_date date,
  due_date date,
  -- Where this bill came from — all manual/upload for now; 'email' and
  -- 'whatsapp' are reserved for when an actual inbox-watching integration is
  -- built (not yet wired up in this app), see lib/billPay.ts.
  source text not null default 'manual',
  source_reference text,
  attachment_url text,
  status bill_status not null default 'pending_review',
  -- Populated by the duplicate-detection check in lib/billPay.ts when a new
  -- bill closely matches an existing one (same vendor + amount within a few
  -- days, or same vendor + invoice number).
  duplicate_of_bill_id text references bills(id),
  flag_reason text,
  confidence_score real,
  reviewed_by_id text references users(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bills_status_idx on bills(status);
create index if not exists bills_vendor_id_idx on bills(vendor_id);
create index if not exists bills_due_date_idx on bills(due_date);

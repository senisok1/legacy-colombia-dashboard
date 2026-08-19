-- Gabriel commissions: paid-extras protection + auto-detected direct-booking
-- referrals + a settlement ledger (2026-08-19, Seni's ask). Three additions:
--
-- 1. booking_extras gets an owner-approval lock — it had NONE before this,
--    so Gabriel could edit/delete his own commission entries at will (see
--    the "NOTE this means a team member enters the two figures his own
--    commission is derived from" comment on the old extras proxy allowlist
--    entry, which flagged exactly this gap). The commission formula is also
--    corrected: Seni clarified the split is guest_paid minus what he pays
--    the VENDOR (chef/masseuse/jet-ski operator/etc.), with the remaining
--    margin split 50/50 between the house and Gabriel — not the full
--    difference going to Gabriel, which is what the old (never actually
--    specified as a formula) commission implied. house_paid is renamed to
--    vendor_paid to match what the number has always actually meant; no
--    data is lost, only the label and the downstream math change.
--
-- 2. direct_booking_commissions tracks Gabriel's 10% cut on any stay he
--    refers directly (90% to the house). OwnerRez's booking `source` field
--    passes through this app untouched (see lib/ownerrez.ts
--    normalizeBooking's `pick(raw, "source", "site", "listing_site")`) —
--    Seni tags these bookings "Gabriel Colombia Referral" in OwnerRez
--    itself, so detection is automatic (any source containing "gabriel",
--    case-insensitive — see lib/directBookingCommissions.ts) rather than a
--    manual flag Gabriel could set himself. The dollar amount is never
--    stored here: it's always computed live from the booking's current
--    totalAmount, same never-store-a-derived-number philosophy as
--    booking_extras' commission.
--
-- 3. commission_settlements is the permanent record of each COP cash
--    handoff — Seni collects physical COP from Gabriel on property visits,
--    and hitting "Settle" doesn't just zero a running balance, it snapshots
--    the FX rate used (with Seni's own visible buffer — never hidden from
--    Gabriel), the total, and which line items were included. Nothing is
--    ever deleted on settlement, only stamped settled_at/settlement_id.

alter table booking_extras rename column house_paid to vendor_paid;
alter table booking_extras add column if not exists approved boolean not null default false;
alter table booking_extras add column if not exists approved_by_email text;
alter table booking_extras add column if not exists approved_by_name text;
alter table booking_extras add column if not exists approved_at timestamptz;
alter table booking_extras add column if not exists declined boolean not null default false;
alter table booking_extras add column if not exists declined_reason text;
alter table booking_extras add column if not exists settled_at timestamptz;
alter table booking_extras add column if not exists settlement_id uuid;

create table if not exists direct_booking_commissions (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  booking_id bigint not null,
  -- Almost always 10 — see COMMISSION_PCT_DEFAULT in
  -- lib/directBookingCommissions.ts. Kept per-row (not hard-coded) in case a
  -- future booking needs a different split without a schema change.
  commission_pct numeric(5,2) not null default 10,
  approved boolean not null default false,
  approved_by_email text,
  approved_by_name text,
  approved_at timestamptz,
  declined boolean not null default false,
  declined_reason text,
  settled_at timestamptz,
  settlement_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, booking_id)
);

create table if not exists commission_settlements (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text,
  settled_by_email text not null,
  settled_by_name text,
  settled_at timestamptz not null default now(),
  -- Live USD->COP rate at settlement time, Seni's stated buffer on top of
  -- it, and the resulting effective_rate actually applied — all three
  -- stored explicitly (not just the total) so a settlement can always be
  -- explained line by line, to Gabriel or to Seni's own bookkeeping, without
  -- ever recomputing a different number later.
  fx_rate numeric(14,4) not null,
  fx_buffer_pct numeric(5,2) not null default 0,
  effective_rate numeric(14,4) not null,
  total_usd numeric(12,2) not null,
  total_cop numeric(14,2) not null,
  note text,
  -- [{type: "extra"|"direct_booking", id, bookingId, amountUsd}, ...] — audit
  -- detail of exactly what was included, kept even though the source rows
  -- also carry this settlement's id, so history survives even if a line
  -- item row were ever deleted.
  line_item_refs jsonb not null default '[]'::jsonb
);

create index if not exists direct_booking_commissions_org_idx
  on direct_booking_commissions (organization_id, booking_id);

create index if not exists commission_settlements_org_idx
  on commission_settlements (organization_id, settled_at desc);

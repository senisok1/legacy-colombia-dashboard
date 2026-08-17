-- Paid extras per guest stay for the Team Management tab (2026-08-17,
-- Seni's ask). Legacy Colombia only for now: Gabriel arranges add-on
-- experiences (chef, massage, jet skis...) during a stay, the guest pays
-- one amount, the house keeps part of it, and the difference is Gabriel's
-- commission. Until now that lived nowhere — it was arranged over WhatsApp
-- and never reconciled against the booking.
--
-- One row per extra per stay, so a single stay can have a chef on Friday
-- and jet skis on Saturday and each is priced separately.
--
-- MONEY. numeric(12,2), never float — these are reconciled against real
-- payouts and binary floating point would drift. Commission is deliberately
-- NOT stored: it is always guest_paid - house_paid, computed on read. A
-- stored third column could disagree with the other two after an edit, and
-- a commission figure that silently contradicts its own inputs is worse
-- than no figure at all.
--
-- SCOPING. Keyed by booking_id like booking_ops, with no property_group_id:
-- a booking belongs to exactly one property group already, and the
-- Management board only ever loads bookings for the active group, so
-- extras cannot leak across properties.
create table if not exists booking_extras (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  booking_id bigint not null,
  -- One of the fixed options; 'other' carries a free-text custom_label.
  kind text not null,
  custom_label text,
  service_date date,
  guest_paid numeric(12,2) not null default 0,
  house_paid numeric(12,2) not null default 0,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now()
);

create index if not exists booking_extras_org_booking_idx
  on booking_extras (organization_id, booking_id);

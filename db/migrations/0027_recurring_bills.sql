-- Monthly recurring bills checklist (2026-08-17, Seni's ask: "create a way
-- to add monthly recurring bills we are aware of for the current month and a
-- checkbox for the owner to check off once it is paid … if not paid, then
-- roll the previous months unpaid bills into the new current month").
--
-- Two tables, deliberately separate:
--   recurring_bills          the RECURRING DEFINITION (name, amount, due day)
--   recurring_bill_payments  one row per (bill, month) once it's ticked paid
--
-- Nothing is written per-month up front. "Paid" is the presence of a
-- recurring_bill_payments row for that YYYY-MM period; every active bill
-- with no row for a given month is simply unpaid. That's what makes the
-- roll-forward free: unpaid past months are just "periods since the bill
-- started that have no payment row", computed at read time, so no cron/
-- month-rollover job can ever fail to run and lose a bill.

create table if not exists recurring_bills (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  -- Which property view this bill belongs to (src/lib/propertyGroups.ts id,
  -- e.g. 'legacy-colombia'). NULL = show under every property.
  property_group_id text,
  name text not null,
  -- Expected amount; nullable because some bills vary month to month.
  amount numeric(12, 2),
  currency text not null default 'USD',
  -- Day of the month it's typically due (1-31), nullable if unknown.
  due_day integer,
  -- First month this bill applies to, 'YYYY-MM'. Roll-forward never looks
  -- at months before this, so adding a bill today doesn't invent a year of
  -- fake overdue history.
  start_period text not null,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists recurring_bills_org_idx on recurring_bills (organization_id, active);

create table if not exists recurring_bill_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  recurring_bill_id uuid not null references recurring_bills(id) on delete cascade,
  -- The month this payment settles, 'YYYY-MM'.
  period text not null,
  amount_paid numeric(12, 2),
  paid_at timestamptz not null default now(),
  paid_by_email text,
  paid_by_name text,
  note text,
  unique (recurring_bill_id, period)
);

create index if not exists recurring_bill_payments_period_idx
  on recurring_bill_payments (organization_id, period);

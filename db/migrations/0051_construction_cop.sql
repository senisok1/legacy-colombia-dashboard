-- COP-primary Construction Budget + open-item costs/allocations
-- (2026-08-21, Seni's ask: "make everything COP on the budget section
-- because that's what all expenses are budgeted with. I will enter the
-- amounts deposited in COP as well... Estimated cost in COP for the open
-- items. Also need to be able to allocate deposited construction funds in
-- COP to those open item expenses as well so every dollar is accounted
-- for.")
--
-- COP becomes the SOURCE OF TRUTH for actual spend, deposits, open-item
-- estimates and fund allocations; USD figures are always DERIVED live at
-- read time from the tab's editable FX rate (construction_budget_settings)
-- and never stored. The old actual_usd / amount_usd columns are kept but
-- retired (nullable, no new writes) — both held only test data that was
-- cleaned up before this migration, so no backfill is needed.

-- Real spend per budget line, entered in COP.
alter table construction_budget_items
  add column if not exists actual_cop numeric(18,2);

-- Deposits entered in COP. amount_usd is retired — make it nullable so new
-- COP-only inserts don't violate the old not-null constraint.
alter table construction_funds_deposits
  add column if not exists amount_cop numeric(18,2);
alter table construction_funds_deposits
  alter column amount_usd drop not null;

-- Estimated cost (COP) per Construction Management open item.
alter table construction_items
  add column if not exists estimated_cost_cop numeric(18,2);

-- Fund allocations: COP amounts drawn from the deposited construction funds
-- against a specific Construction Management open item — the "every dollar
-- accounted for" ledger for spend that isn't a budget line item. Append-only
-- entries (like the notes threads); removal is Seni-only at the API layer.
create table if not exists construction_item_fund_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null default 'legacy-colombia',
  item_id uuid not null references construction_items(id) on delete cascade,

  amount_cop numeric(18,2) not null,
  note text,

  created_at timestamptz not null default now(),
  created_by_email text not null,
  created_by_name text
);

create index if not exists construction_item_fund_allocations_org_idx
  on construction_item_fund_allocations (organization_id, property_group_id, item_id);

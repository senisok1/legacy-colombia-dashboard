-- Construction Funds deposits (2026-08-20, Seni's ask: "a 'remaining
-- balance' box that shows construction funds I've deposited but haven't
-- been used yet... funds that I deposit are always accounted for"). A
-- ledger separate from construction_budget_items — deposits are real cash
-- Seni has put into the project, independent of any single line item's
-- budgeted/actual figures, and deliberately live in their own table so a
-- budget re-import (which wipes and recreates construction_budget_items,
-- see replaceConstructionBudgetItems) never touches them. "Spent" for
-- balance purposes is computed live from actual_usd already tracked per
-- line item — no separate spend table needed.
create table if not exists construction_funds_deposits (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null default 'legacy-colombia',

  amount_usd numeric(14,2) not null,
  note text,
  deposited_at date not null default current_date,

  created_at timestamptz not null default now(),
  created_by_email text not null,
  created_by_name text
);

create index if not exists construction_funds_deposits_org_idx
  on construction_funds_deposits (organization_id, property_group_id, deposited_at);

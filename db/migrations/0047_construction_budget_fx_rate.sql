-- Editable COP -> USD exchange rate for Construction Budget (2026-08-20,
-- Seni's ask: "this is currently at a 3700 COP to USD exchange rate. add a
-- box somewhere where I can modify that rate which will then modify the USD
-- budget"). One row per org+property group; Budgeted (USD) is recomputed
-- live from each row's total_cop / this rate whenever total_cop is present
-- (see lib/constructionBudget.ts's applyFxRate) rather than staying pinned
-- to the fixed historical rate baked into the original spreadsheet.
create table if not exists construction_budget_settings (
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null default 'legacy-colombia',
  fx_rate_cop_per_usd numeric(10,2) not null default 3700,
  updated_at timestamptz not null default now(),
  updated_by_email text,
  updated_by_name text,
  primary key (organization_id, property_group_id)
);

-- Construction Budget (2026-08-20, Seni's ask): a dropdown tab under
-- Construction Management showing the imported budget spreadsheet
-- ("260708_Nukak House 17-Preliminary Construction Budget") as a live,
-- editable table — grouped by chapter/category, with an Actual (USD) column
-- admins can fill in over time to track spend against budget.
--
-- Schema mirrors the real spreadsheet's structure (previewed via its public
-- Google Sheets link): a chapter code (CODIGO, e.g. "1.01"), a bilingual
-- chapter/category name and line-item description (the sheet has parallel
-- Spanish/English columns throughout), unit, quantity, unit price and total
-- in COP, and a budgeted total in USD (the sheet computed this with a fixed
-- historical FX rate baked into the sheet itself, not a live conversion —
-- stored as-is rather than recomputed). sort_order preserves the row order
-- from the source sheet within each category.
create table if not exists construction_budget_items (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null default 'legacy-colombia',

  code text,
  category text not null,
  category_original text,
  description text not null,
  description_original text,
  unit text,
  quantity numeric(14,3),
  unit_price_cop numeric(16,2),
  total_cop numeric(16,2),
  budgeted_usd numeric(14,2),

  -- Filled in over time as construction progresses — not part of the
  -- original import. Nullable = "nothing spent/recorded yet".
  actual_usd numeric(14,2),
  notes text,

  sort_order integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_email text,
  updated_by_name text
);

create index if not exists construction_budget_items_org_idx
  on construction_budget_items (organization_id, property_group_id, sort_order);

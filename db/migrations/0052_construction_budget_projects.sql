-- Construction Budget: multiple projects per property (2026-08-21, Seni's
-- ask: "we need to be able to toggle between different projects within
-- that property... House 17 Construction... Pool Construction... upload
-- the spreadsheet and do the same thing for this project"). A property can
-- now hold more than one independent budget (line items + their activity
-- trail) side by side, switched via a tab/dropdown in
-- ConstructionBudgetBoard.tsx. The COP/USD exchange rate
-- (construction_budget_settings) and Construction Funds
-- (construction_funds_deposits / remaining balance) stay PROPERTY-WIDE, not
-- per-project (Seni, asked directly: "shared pot... spent down by whichever
-- project's actuals draw on it") — only line items, their notes, and their
-- own activity-log entries are project-scoped.
create table if not exists construction_budget_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id) on delete cascade,
  property_group_id text not null,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by_email text,
  created_by_name text
);

create index if not exists construction_budget_projects_org_idx
  on construction_budget_projects (organization_id, property_group_id, sort_order);

-- Backfill: every property that already has budget items gets one default
-- project named "House 17 Construction" (Seni's own name for what's
-- currently in there), and every existing line item is attached to it —
-- nothing about the existing budget changes visually, it's just now
-- addressable as one project among possibly several.
insert into construction_budget_projects (organization_id, property_group_id, name, sort_order)
select distinct organization_id, property_group_id, 'House 17 Construction', 0
from construction_budget_items;

alter table construction_budget_items
  add column if not exists project_id uuid references construction_budget_projects(id) on delete cascade;

update construction_budget_items cbi
  set project_id = p.id
  from construction_budget_projects p
  where cbi.project_id is null
    and p.organization_id = cbi.organization_id
    and p.property_group_id = cbi.property_group_id
    and p.name = 'House 17 Construction';

create index if not exists construction_budget_items_project_idx
  on construction_budget_items (project_id, sort_order);

-- Activity log entries about a specific line item (imported/updated/
-- deleted/noted) get attached to that item's project so a project's log
-- view only shows its own item history. Property-wide events (FX rate
-- changes, fund deposits, new-project creation) are left with a null
-- project_id on purpose — those still show no matter which project tab is
-- open, since they're not about any one project's line items.
alter table construction_budget_activity_log
  add column if not exists project_id uuid references construction_budget_projects(id) on delete set null;

update construction_budget_activity_log cbl
  set project_id = p.id
  from construction_budget_projects p
  where cbl.project_id is null
    and cbl.item_id is not null
    and p.organization_id = cbl.organization_id
    and p.property_group_id = cbl.property_group_id
    and p.name = 'House 17 Construction';

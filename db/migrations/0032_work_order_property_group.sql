-- Work orders were the last input to the daily executive summary still
-- pooled across every property (2026-08-17, Seni: "no bleed through or
-- sharing data"). Same NULL-means-default-group convention as migration
-- 0030 — see propertyGroupFilter() in src/lib/db.ts.
alter table work_orders add column if not exists property_group_id text;

create index if not exists work_orders_property_group_idx
  on work_orders (organization_id, property_group_id);

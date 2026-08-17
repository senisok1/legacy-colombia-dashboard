-- The Management tab's general activity log was the last team-facing list
-- still pooled across every property (2026-08-17 audit, following the same
-- "no bleed through or sharing data" line as migrations 0030/0032/0033).
--
-- team_activities had no property column at all, so every "pool cleaned",
-- "restocked towels" or per-stay note written by any property's on-site team
-- appeared on all five properties' Management boards. Worse than noise: a
-- cleaner logged in for one property could read another property's
-- operational chatter.
--
-- Existing rows are left NULL, which reads as Legacy Colombia via
-- propertyGroupFilter() in src/lib/db.ts — correct here, because until the
-- other properties were added every activity was written by (and about)
-- Legacy Colombia.
alter table team_activities add column if not exists property_group_id text;

create index if not exists team_activities_property_group_idx
  on team_activities (organization_id, property_group_id);

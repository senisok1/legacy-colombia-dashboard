-- Marketing → Campaigns was pooling every property's re-engagement
-- candidates (2026-08-17, Seni: "the marketing tab campaigns seem to be
-- bleeding between properties. Alva doesn't have that many past guests yet").
--
-- lifecycle_campaign_candidates had no property column at all, so the win-
-- back / referral / abandoned-booking lists were organization-wide and every
-- property showed the same guests. Existing rows are NULL, which reads as
-- Legacy Colombia — correct, because the detector cron ran unscoped and
-- therefore only ever saw Colombia's bookings.
alter table lifecycle_campaign_candidates add column if not exists property_group_id text;

create index if not exists lifecycle_candidates_property_group_idx
  on lifecycle_campaign_candidates (organization_id, property_group_id);

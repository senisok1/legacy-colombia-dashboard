-- Per-property scoping for the DB-backed tabs (2026-08-17, Seni: "I see
-- Legacy Colombia data on the Legacy Alva Marketing, Reports and Bill Pay
-- tabs").
--
-- Everything that reads from OwnerRez was already scoped by passing a
-- property-group id down to getBookings/getGuests. These tables are the
-- other half: rows the dashboard itself creates, which until now were only
-- tagged with organization_id and therefore showed up under every property.
--
-- Rule used everywhere (see propertyGroupFilter() in src/lib/db.ts):
--   a row belongs to the active group when
--     property_group_id = <active group>
--     OR (property_group_id is null AND <active group> is the default)
--
-- The NULL branch is deliberate: every row that exists today predates
-- multi-property support and belongs to Legacy Colombia, so a NULL reads as
-- "Legacy Colombia" without needing a data backfill that could mis-tag
-- anything. New rows are stamped explicitly by the write paths.

alter table vendors             add column if not exists property_group_id text;
alter table bills               add column if not exists property_group_id text;
alter table content_pieces      add column if not exists property_group_id text;
alter table content_campaigns   add column if not exists property_group_id text;
alter table marketing_contacts  add column if not exists property_group_id text;
alter table leads               add column if not exists property_group_id text;

create index if not exists bills_property_group_idx
  on bills (organization_id, property_group_id);
create index if not exists content_pieces_property_group_idx
  on content_pieces (organization_id, property_group_id);
create index if not exists marketing_contacts_property_group_idx
  on marketing_contacts (organization_id, property_group_id);

-- Phase 7b — Social Media Manager (formalizes Agent #4 "Marketing Director"
-- from docs/VISION.md). Adds weekly "campaign" grouping on top of the
-- existing content_pieces table: one campaign = one pillar asset (a video,
-- photo set, or theme) repurposed into many content_pieces (one per
-- channel). Also adds the columns needed to push an approved piece to
-- Postiz for real scheduling/publishing once that integration is
-- configured (see src/lib/postiz.ts) — until then these columns just sit
-- null and behavior is unchanged. Fully additive: existing content_pieces
-- rows get campaign_id = null and keep working exactly as before.

do $$ begin
  create type content_campaign_status as enum ('draft', 'generating', 'ready_for_review', 'approved', 'archived');
exception when duplicate_object then null;
end $$;

create table if not exists content_campaigns (
  id text primary key default gen_random_uuid()::text,
  organization_id text not null references organizations(id),
  pillar_asset_description text not null,
  pillar_asset_media_url text,
  status content_campaign_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_campaigns_organization_id_idx on content_campaigns(organization_id);
create index if not exists content_campaigns_status_idx on content_campaigns(status);

alter table content_pieces add column if not exists campaign_id text references content_campaigns(id);
alter table content_pieces add column if not exists media_url text;
alter table content_pieces add column if not exists postiz_post_id text;
alter table content_pieces add column if not exists scheduled_at timestamptz;

create index if not exists content_pieces_campaign_id_idx on content_pieces(campaign_id);

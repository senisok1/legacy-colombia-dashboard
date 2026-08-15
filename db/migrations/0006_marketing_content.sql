-- Phase 7 of the Legacy AI Company roadmap (see docs/VISION.md) — Marketing,
-- social, and SEO. Combines VISION.md's Marketing Director (agent #4) and SEO
-- Manager (agent #5) into one content pipeline for v1, since both feed the
-- same review queue and neither has a live publishing integration yet.
--
-- IMPORTANT SCOPE NOTE: this app has no connected social-media posting API
-- (Instagram/Facebook/TikTok/etc.), no CMS integration for Seni's actual
-- website, and no live web-search/SEO-data API (SEMrush, Ahrefs, Google
-- Search Console, etc.) wired up. Per VISION.md's phased-rollout guardrail
-- ("observation mode -> recommendation-only -> ... -> Seni approves
-- activation" before any automation), and because there is no reliable API
-- to publish through yet (browser automation is explicitly last-resort, never
-- the primary path, per VISION.md's guardrails), this phase is scoped to
-- DRAFTING AND REVIEW ONLY: content_pieces holds AI-drafted blog
-- posts/social captions/email copy for Seni to copy out and publish himself
-- through his own tools. Nothing in this schema or lib/contentMarketing.ts
-- posts anywhere automatically. 'published_externally' just means "Seni
-- confirms he posted this somewhere himself" — a record-keeping status, not
-- a system action.
--
-- Applied via GET /api/admin/migrate?secret=... (see that route's comment
-- for why — Sensitive DATABASE_URL can't be pulled locally on this project).

do $$ begin
  create type content_piece_type as enum ('blog', 'social', 'email');
exception when duplicate_object then null; end $$;

do $$ begin
  create type content_piece_status as enum ('idea', 'draft', 'approved', 'published_externally', 'archived');
exception when duplicate_object then null; end $$;

create table if not exists content_pieces (
  id text primary key default gen_random_uuid()::text,
  content_type content_piece_type not null,
  topic text not null,
  -- Free text since no platform is actually connected — e.g. "Instagram",
  -- "Blog", "Facebook", "Email newsletter", "Google My Business".
  channel text,
  -- Primary SEO keyword this piece targets, if any (mainly used for blog).
  target_keyword text,
  body text,
  meta_description text,
  -- Free-text rationale: why this topic/keyword, competitive angle, etc.
  -- Written by the AI drafting step, reviewed by Seni — not sourced from any
  -- live SEO-data API (none is connected, see header comment above).
  seo_notes text,
  property_id text references properties(id),
  status content_piece_status not null default 'idea',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_pieces_status_idx on content_pieces(status);
create index if not exists content_pieces_type_idx on content_pieces(content_type);

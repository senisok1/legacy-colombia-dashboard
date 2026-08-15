-- Phase 5 of the Legacy AI Company roadmap (see docs/VISION.md) — Revenue
-- Manager, SHADOW MODE ONLY. This migration adds nowhere to write a rate back
-- to OwnerRez or PriceLabs, and no code path in this app ever calls a
-- write/PATCH endpoint against either — see lib/revenueManager.ts's header
-- comment. The whole point of this table is to build an honest, append-style
-- track record comparing the AI's own recommendation against what PriceLabs
-- suggested and what was actually live in OwnerRez, for the SAME future
-- night, snapshotted repeatedly as that night gets closer — only once that
-- record shows the AI reliably calling it as well or better than PriceLabs
-- does Seni decide whether to let it touch a live rate (see VISION.md's
-- phased-roadmap guardrail).
--
-- Applied via GET /api/admin/migrate?secret=... (same as 0001/0002 — see that
-- route's comment for why: DATABASE_URL is a Vercel "Sensitive" var that can
-- never be pulled to run migrations locally).

create table if not exists rate_snapshots (
  id text primary key default gen_random_uuid()::text,
  property_id text references properties(id),
  -- The future night being priced (e.g. 2026-09-15) — NOT when this row was
  -- written. A single stay_date accumulates multiple rows over time (one per
  -- run_date) as the AI's/PriceLabs' read on that night evolves the closer it
  -- gets, which is exactly the track record shadow mode needs to build.
  stay_date date not null,
  -- The day this snapshot was captured. Defaults to today but is passed
  -- explicitly by the cron job so a late-running job still logs against the
  -- intended day rather than whatever moment it happened to finish.
  run_date date not null default current_date,
  ownerrez_rate_cents integer,
  pricelabs_rate_cents integer,
  ai_recommended_rate_cents integer,
  ai_reasoning text,
  ai_confidence text,
  created_at timestamptz not null default now(),
  -- One row per (property, night, day-captured) — re-running the cron the
  -- same day updates the existing row instead of piling up duplicates.
  unique (property_id, stay_date, run_date)
);
create index if not exists rate_snapshots_stay_date_idx on rate_snapshots(stay_date);
create index if not exists rate_snapshots_run_date_idx on rate_snapshots(run_date);

-- Registers the agent (if it doesn't already exist from some earlier manual
-- setup) so ai_activity_log entries have somewhere to attach. SHADOW mode
-- per VISION.md phase 5 — recommend and log only, no automatic rate changes.
insert into agents (key, display_name, description, mode)
values (
  'revenue_manager',
  'AI Revenue Manager',
  'Occupancy/ADR/RevPAR optimization — shadow mode only. Recommends nightly rates and logs them against PriceLabs and actual OwnerRez rates; never changes a live price.',
  'SHADOW'
)
on conflict (key) do nothing;

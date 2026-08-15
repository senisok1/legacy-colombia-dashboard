-- Phase 5b of the Legacy AI Company roadmap — promotes Revenue Manager out
-- of shadow mode. rate_snapshots (0003) is untouched and keeps working
-- exactly as before: an append-only AI-vs-PriceLabs-vs-OwnerRez comparison
-- log. This migration adds the audit trail for the NEW capability layered on
-- top of it: Seni reviewing a recommended (or manually typed) rate for one
-- future night in the Revenue Management tab and clicking "Apply."
--
-- That click pushes a Date Specific Override into PriceLabs
-- (POST /v1/listings/{id}/overrides, pms=ownerrez) rather than writing
-- directly to OwnerRez's own PATCH /v2/spotrates endpoint. Reason: PriceLabs
-- owns the live pricing sync into OwnerRez via its own separate Integration
-- API and treats itself as the source of truth for this listing — a direct
-- OwnerRez write risks being silently clobbered by PriceLabs' next scheduled
-- sync. Writing the override into PriceLabs instead means PriceLabs picks it
-- up as the new source of truth and pushes it into OwnerRez itself, on its
-- own normal sync cadence (not instant). See lib/pricelabs.ts's
-- applyDateOverride() and lib/revenueManager.ts's applyRateOverride().
--
-- Nothing here is ever triggered automatically — every row is the direct
-- result of an explicit, single-date "Apply this rate" click. There is no
-- batch-apply and no cron/scheduled path that writes to this table. See
-- api/revenue/apply/route.ts.
--
-- Applied via GET /api/admin/migrate?secret=... (DATABASE_URL is a Vercel
-- "Sensitive" var that can't be pulled to run migrations locally).

create table if not exists rate_overrides (
  id text primary key default gen_random_uuid()::text,
  property_id text references properties(id),
  stay_date date not null,
  applied_price_cents integer not null,
  currency text not null default 'USD',
  -- What the AI had recommended at the moment of the click, for audit only —
  -- may differ from applied_price_cents if Seni edited the number before
  -- applying. Does not gate the apply itself.
  ai_recommended_rate_cents integer,
  reason text,
  -- Raw response body from PriceLabs' /overrides call, for troubleshooting if
  -- a push doesn't show up in OwnerRez as expected.
  pricelabs_response jsonb,
  status text not null default 'applied', -- 'applied' | 'failed'
  error text,
  created_at timestamptz not null default now()
);
create index if not exists rate_overrides_stay_date_idx on rate_overrides(stay_date);
create index if not exists rate_overrides_property_id_idx on rate_overrides(property_id);

-- Revenue Manager can now push a real rate — but only ever behind Seni's
-- explicit per-date approval click, never automatically. APPROVAL (not
-- LIMITED_AUTO/FULL_AUTO) reflects that every write requires a human click.
update agents set mode = 'APPROVAL' where key = 'revenue_manager';

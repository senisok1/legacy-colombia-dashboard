-- Phase 5c of the Legacy AI Company roadmap — adds a configurable "auto-apply
-- band" to Revenue Manager (see lib/revenueManager.ts's runAutoApplyPass()):
-- when Seni explicitly sets REVENUE_AUTO_APPLY_ENABLED=true in Vercel (ships
-- OFF by default — this is a deliberate out-of-band step, not a dashboard
-- toggle), the daily snapshot cron will also push any date whose AI
-- recommendation sits within REVENUE_AUTO_APPLY_BAND_PCT percent of
-- OwnerRez's live quoted rate, with no per-date click required.
--
-- This makes 0009_rate_overrides.sql's original "nothing here is ever
-- triggered automatically" comment no longer universally true, so this
-- column exists to keep every row honestly labeled: 'manual' for the
-- existing single-date "Apply this rate" click flow (api/revenue/apply),
-- 'auto_apply_band' for the new autopilot path. Defaults every existing and
-- future manually-triggered row to 'manual' so nothing in the audit trail
-- silently becomes ambiguous.
--
-- Applied via GET /api/admin/migrate?secret=... (see that route's comment).

alter table rate_overrides
  add column if not exists triggered_by text not null default 'manual'
    check (triggered_by in ('manual', 'auto_apply_band'));

create index if not exists rate_overrides_triggered_by_idx on rate_overrides(triggered_by);

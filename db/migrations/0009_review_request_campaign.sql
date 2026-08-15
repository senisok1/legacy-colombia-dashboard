-- Adds 'review_request' as a fourth lifecycle-campaign type, alongside
-- win_back / referral / abandoned_booking (see 0005_lifecycle_campaigns.sql).
-- Trigger: Legacy Colombia's Google Business Profile had 278 customer
-- interactions but only 3 Google reviews as of 2026-08-04 — the single
-- biggest lever for local-search visibility per Google's own guidance
-- ("profiles with 5+ reviews get up to 2x the customer engagement").
--
-- Same guardrails as every other campaign type: every row starts as
-- 'candidate' and nothing is sent without Seni's explicit approval (see
-- lib/lifecycleMarketing.ts). The drafted message never claims a review was
-- already left, never offers anything in exchange for a positive review
-- (that would violate Google's review policies), and the direct Google
-- review link (https://g.page/r/CZAJnJ0y5JQiEBM/review, pulled from the GBP
-- dashboard's "Ask for reviews" panel) is appended programmatically after
-- drafting rather than trusted to Claude's translation, so it can never be
-- mangled across languages.
--
-- Applied via GET /api/admin/migrate?secret=... (see that route's comment).

alter type lifecycle_campaign_type add value if not exists 'review_request';

-- Phase 4: Stripe subscription billing. organizations already has
-- plan/stripe_customer_id/stripe_subscription_id/subscription_status/
-- trial_ends_at from migration 0015 (Phase 0) — this adds the one field
-- that was still missing (which billing cadence a tenant picked, so the
-- billing page can show "$X/mo, billed annually" correctly) and a small
-- table to capture 101+-property "talk to sales" enterprise inquiries,
-- since those never go through Stripe Checkout at all (see
-- lib/billing.ts's PRICING_TIERS — there is no self-serve Price for
-- Enterprise).

alter table organizations add column if not exists billing_interval text not null default 'monthly';

create table if not exists enterprise_inquiries (
  id text primary key default gen_random_uuid()::text,
  organization_id text references organizations(id),
  name text not null,
  email text not null,
  property_count integer,
  message text,
  created_at timestamptz not null default now()
);
create index if not exists enterprise_inquiries_organization_id_idx on enterprise_inquiries(organization_id);

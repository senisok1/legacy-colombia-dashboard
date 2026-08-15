import { config } from "./config";
import type { Organization, SubscriptionStatus } from "./organizations";

// Phase 4 pricing — confirmed with Seni 2026-08-05, benchmarked against
// Hostaway, Guesty, Hospitable, Lodgify, and OwnerRez itself (bare
// PMS/channel-manager pricing clusters $15-40/property/month at small
// scale, tapering to $10-25/property at 30-100+ units). Priced above that
// band because this product is a superset of a bare PMS — revenue
// management, reputation management, lifecycle marketing, an AI WhatsApp
// concierge, vendor/maintenance ops, and bill pay are each normally a
// separate paid tool.
//
// Fixed per-tier Stripe Prices (not metered/per-seat) so billing stays
// simple — see api/billing/checkout. Property count only determines which
// tier an org is *offered*/nudged toward; it isn't read by Stripe itself.
export type BillingInterval = "monthly" | "annual";

export type PricingTier = {
  id: string;
  name: string;
  minProperties: number;
  maxProperties: number; // inclusive
  monthlyPriceCents: number;
  annualPriceCents: number; // ~2 months free vs. monthly x12
  stripePriceIdMonthly: string;
  stripePriceIdAnnual: string;
};

export const PRICING_TIERS: PricingTier[] = [
  {
    id: "solo",
    name: "Solo",
    minProperties: 1,
    maxProperties: 1,
    monthlyPriceCents: 5_900,
    annualPriceCents: 59_000,
    stripePriceIdMonthly: config.stripePriceSoloMonthly,
    stripePriceIdAnnual: config.stripePriceSoloAnnual,
  },
  {
    id: "starter",
    name: "Starter",
    minProperties: 2,
    maxProperties: 5,
    monthlyPriceCents: 12_900,
    annualPriceCents: 129_000,
    stripePriceIdMonthly: config.stripePriceStarterMonthly,
    stripePriceIdAnnual: config.stripePriceStarterAnnual,
  },
  {
    id: "growth",
    name: "Growth",
    minProperties: 6,
    maxProperties: 15,
    monthlyPriceCents: 29_900,
    annualPriceCents: 299_000,
    stripePriceIdMonthly: config.stripePriceGrowthMonthly,
    stripePriceIdAnnual: config.stripePriceGrowthAnnual,
  },
  {
    id: "scale",
    name: "Scale",
    minProperties: 16,
    maxProperties: 30,
    monthlyPriceCents: 54_900,
    annualPriceCents: 549_000,
    stripePriceIdMonthly: config.stripePriceScaleMonthly,
    stripePriceIdAnnual: config.stripePriceScaleAnnual,
  },
  {
    id: "pro",
    name: "Pro",
    minProperties: 31,
    maxProperties: 60,
    monthlyPriceCents: 94_900,
    annualPriceCents: 949_000,
    stripePriceIdMonthly: config.stripePriceProMonthly,
    stripePriceIdAnnual: config.stripePriceProAnnual,
  },
  {
    id: "portfolio",
    name: "Portfolio",
    minProperties: 61,
    maxProperties: 100,
    monthlyPriceCents: 149_900,
    annualPriceCents: 1_499_000,
    stripePriceIdMonthly: config.stripePricePortfolioMonthly,
    stripePriceIdAnnual: config.stripePricePortfolioAnnual,
  },
];

/** 101+ properties never gets a self-serve Stripe Checkout — routes to
 * api/billing/enterprise-contact instead (Seni's explicit call, 2026-08-05). */
export const ENTERPRISE_MIN_PROPERTIES = 101;

export function getTierById(id: string): PricingTier | undefined {
  return PRICING_TIERS.find((t) => t.id === id);
}

/** Which self-serve tier an org's current property count falls into, or
 * "enterprise" once they're past the 100-property ceiling. Property counts
 * of 0 (brand-new signup, nothing connected yet) default to Solo rather
 * than falling through to undefined. */
export function getTierForPropertyCount(count: number): PricingTier | "enterprise" {
  if (count >= ENTERPRISE_MIN_PROPERTIES) return "enterprise";
  return PRICING_TIERS.find((t) => count >= t.minProperties && count <= t.maxProperties) ?? PRICING_TIERS[0];
}

export function priceIdFor(tier: PricingTier, interval: BillingInterval): string {
  return interval === "annual" ? tier.stripePriceIdAnnual : tier.stripePriceIdMonthly;
}

/** Reverse lookup used by the Stripe webhook handler — Stripe tells us
 * which Price a subscription is on, we need to know which of our tier ids
 * (stored in organizations.plan) that corresponds to. */
export function tierIdFromPriceId(priceId: string): string | undefined {
  return PRICING_TIERS.find((t) => t.stripePriceIdMonthly === priceId || t.stripePriceIdAnnual === priceId)?.id;
}

export function intervalFromPriceId(priceId: string): BillingInterval | undefined {
  const tier = PRICING_TIERS.find((t) => t.stripePriceIdMonthly === priceId || t.stripePriceIdAnnual === priceId);
  if (!tier) return undefined;
  return tier.stripePriceIdAnnual === priceId ? "annual" : "monthly";
}

/** The Phase 4 access policy: hard lock, no read-only grace period (Seni's
 * explicit call, 2026-08-05) — a trial that's run out, a canceled
 * subscription, or a failed payment all mean "can't use the app until
 * billing is sorted," full stop. Called from lib/billingGate.ts. */
export function isOrgLocked(org: Pick<Organization, "subscriptionStatus" | "trialEndsAt">): boolean {
  const status: SubscriptionStatus = org.subscriptionStatus;
  if (status === "past_due" || status === "canceled") return true;
  if (status === "trialing") {
    if (!org.trialEndsAt) return false; // no trial end set — fail open, not closed
    return new Date(org.trialEndsAt).getTime() < Date.now();
  }
  return false; // "active"
}

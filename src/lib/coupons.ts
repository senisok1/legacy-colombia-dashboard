import type Stripe from "stripe";
import { getStripeClient } from "./stripe";

// Platform-operator coupon management (2026-08-05, Seni's ask: "give
// discounts or free accounts away"). Deliberately backed entirely by
// Stripe's own Coupon + Promotion Code objects rather than a table of our
// own — Stripe already handles validation, expiration, redemption limits,
// and (via Checkout's allow_promotion_codes: true, see
// api/billing/checkout/route.ts) the actual "customer types a code at
// checkout" UI, so duplicating any of that here would just be a second
// place for it to drift out of sync. This file only creates/lists/toggles
// codes; api/billing/coupons/route.ts gates who's allowed to call it (only
// the platform's own default org — see lib/credentials.ts's isDefaultOrg).
//
// "Free account" = a promotion code on a 100%-off, duration "forever"
// coupon. It still goes through Stripe Checkout and gets a real (albeit
// $0) subscription, so it shows up in Stripe's own records and the
// existing webhook sync (api/webhooks/stripe) sets subscription_status to
// "active" exactly like any paid plan — no separate bypass path needed.
export type CouponInput = {
  code?: string; // omit to let Stripe generate one
  percentOff?: number; // 1-100 — ignored if freeForever is true
  amountOffCents?: number; // alternative to percentOff — ignored if percentOff or freeForever is set
  freeForever?: boolean; // shorthand for percentOff: 100, duration: "forever"
  duration?: "once" | "forever" | "repeating";
  durationInMonths?: number; // required when duration is "repeating"
  maxRedemptions?: number;
  expiresAt?: string; // ISO date
};

export type PromotionCodeSummary = {
  id: string;
  code: string;
  active: boolean;
  percentOff: number | null;
  amountOffCents: number | null;
  duration: string;
  durationInMonths: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  expiresAt: string | null;
  createdAt: string;
};

function toSummary(pc: Stripe.PromotionCode): PromotionCodeSummary {
  const coupon = pc.coupon;
  return {
    id: pc.id,
    code: pc.code,
    active: pc.active,
    percentOff: coupon.percent_off ?? null,
    amountOffCents: coupon.amount_off ?? null,
    duration: coupon.duration,
    durationInMonths: coupon.duration_in_months ?? null,
    maxRedemptions: pc.max_redemptions ?? null,
    timesRedeemed: pc.times_redeemed,
    expiresAt: pc.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
    createdAt: new Date(pc.created * 1000).toISOString(),
  };
}

export async function createPromotionCode(input: CouponInput): Promise<PromotionCodeSummary> {
  const stripe = getStripeClient();

  const percentOff = input.freeForever ? 100 : input.percentOff;
  const amountOffCents = !input.freeForever && !percentOff ? input.amountOffCents : undefined;
  const duration = input.freeForever ? "forever" : (input.duration ?? "once");

  if (!percentOff && !amountOffCents) {
    throw new Error("Provide either percentOff, amountOffCents, or freeForever.");
  }

  const coupon = await stripe.coupons.create({
    percent_off: percentOff,
    amount_off: amountOffCents,
    currency: amountOffCents ? "usd" : undefined,
    duration,
    duration_in_months: duration === "repeating" ? input.durationInMonths : undefined,
  });

  const promotionCode = await stripe.promotionCodes.create({
    coupon: coupon.id,
    code: input.code || undefined,
    max_redemptions: input.maxRedemptions,
    expires_at: input.expiresAt ? Math.floor(new Date(input.expiresAt).getTime() / 1000) : undefined,
  });
  // Stripe's create response doesn't expand `coupon` by default — refetch
  // with the expansion so toSummary() has the discount details to show.
  const expanded = await stripe.promotionCodes.retrieve(promotionCode.id, { expand: ["coupon"] });
  return toSummary(expanded);
}

export async function listPromotionCodes(): Promise<PromotionCodeSummary[]> {
  const stripe = getStripeClient();
  const result = await stripe.promotionCodes.list({ limit: 100, expand: ["data.coupon"] });
  return result.data.map(toSummary);
}

export async function setPromotionCodeActive(id: string, active: boolean): Promise<void> {
  const stripe = getStripeClient();
  await stripe.promotionCodes.update(id, { active });
}

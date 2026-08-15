import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getOrganizationById } from "@/lib/organizations";
import { getTierById, priceIdFor, type BillingInterval } from "@/lib/billing";
import { isStripeConfigured } from "@/lib/config";
import { getStripeClient } from "@/lib/stripe";

// Creates a Stripe Checkout session for a self-serve tier (Solo through
// Portfolio — Enterprise has no Price id and never reaches this route, see
// api/billing/enterprise-contact). Reuses the org's existing Stripe
// Customer if one was already created by a prior checkout attempt;
// otherwise Checkout creates one and the webhook (checkout.session.completed)
// records it.
export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing isn't configured on this deployment yet." }, { status: 400 });
  }

  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { tierId?: string; interval?: BillingInterval } | null;
  const tier = body?.tierId ? getTierById(body.tierId) : undefined;
  const interval: BillingInterval = body?.interval === "annual" ? "annual" : "monthly";

  if (!tier) {
    return NextResponse.json({ error: "Unknown or missing tierId." }, { status: 400 });
  }
  const priceId = priceIdFor(tier, interval);
  if (!priceId) {
    return NextResponse.json(
      { error: `No Stripe Price configured for ${tier.id}/${interval} yet.` },
      { status: 400 }
    );
  }

  const org = await getOrganizationById(session.organizationId);
  if (!org) return NextResponse.json({ error: "Organization not found." }, { status: 404 });

  const stripe = getStripeClient();
  const origin = req.nextUrl.origin;

  // If the org is mid-trial and subscribes early, align Stripe's own
  // trial_end to our trial_ends_at so they aren't charged before the free
  // trial they were promised actually runs out. Past that date (the normal
  // "trial expired, now pick a plan" path from the hard-lock redirect),
  // billing starts immediately on checkout completion.
  const trialEndUnix =
    org.subscriptionStatus === "trialing" && org.trialEndsAt && new Date(org.trialEndsAt).getTime() > Date.now()
      ? Math.floor(new Date(org.trialEndsAt).getTime() / 1000)
      : undefined;

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    // If there's no Stripe Customer yet, Checkout collects the email itself.
    customer: org.stripeCustomerId ?? undefined,
    client_reference_id: org.id,
    line_items: [{ price: priceId, quantity: 1 }],
    // Lets Stripe's own hosted Checkout page render an "Add promotion
    // code" field — the actual redemption UI for any coupon created via
    // /api/billing/coupons (see lib/coupons.ts). No custom code-entry flow
    // needed in this app; Stripe validates and applies the discount.
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { organizationId: org.id, tierId: tier.id },
      ...(trialEndUnix ? { trial_end: trialEndUnix } : {}),
    },
    metadata: { organizationId: org.id, tierId: tier.id, interval },
    success_url: `${origin}/billing?checkout=success`,
    cancel_url: `${origin}/billing?checkout=cancelled`,
  });

  if (!checkoutSession.url) {
    return NextResponse.json({ error: "Stripe didn't return a Checkout URL." }, { status: 502 });
  }

  return NextResponse.json({ url: checkoutSession.url });
}

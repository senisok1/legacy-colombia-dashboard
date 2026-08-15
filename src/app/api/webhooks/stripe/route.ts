import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { config } from "@/lib/config";
import { getStripeClient } from "@/lib/stripe";
import { updateOrganizationSubscription, type SubscriptionStatus } from "@/lib/organizations";
import { tierIdFromPriceId, intervalFromPriceId } from "@/lib/billing";

// Keeps organizations.subscription_status/plan/stripe_* in sync with what
// actually happened on Stripe's side — the Checkout/Portal routes only ever
// *start* an action; this is what actually commits the result. Must read
// the raw body (not req.json()) since Stripe's signature is computed over
// the exact bytes sent — see Stripe's webhook signing docs.
export const runtime = "nodejs";

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus | null {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete_expired":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      // "incomplete" (first payment still processing) — don't overwrite
      // whatever status the org already has yet.
      return null;
  }
}

async function syncSubscription(subscription: Stripe.Subscription, organizationIdHint?: string) {
  const organizationId = subscription.metadata?.organizationId || organizationIdHint;
  if (!organizationId) return;

  const priceId = subscription.items.data[0]?.price?.id;
  const tierId = priceId ? tierIdFromPriceId(priceId) : undefined;
  const interval = priceId ? intervalFromPriceId(priceId) : undefined;
  const status = mapStripeStatus(subscription.status);

  await updateOrganizationSubscription(organizationId, {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    subscriptionStatus: status ?? undefined,
    plan: tierId,
    billingInterval: interval,
  });
}

export async function POST(req: NextRequest) {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    return NextResponse.json({ error: "Stripe isn't configured on this deployment." }, { status: 400 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing stripe-signature header." }, { status: 400 });

  const rawBody = await req.text();
  const stripe = getStripeClient();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  } catch (err) {
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 400 }
    );
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const checkoutSession = event.data.object as Stripe.Checkout.Session;
      const organizationId = checkoutSession.client_reference_id || checkoutSession.metadata?.organizationId;
      if (organizationId && checkoutSession.subscription) {
        const subscriptionId =
          typeof checkoutSession.subscription === "string"
            ? checkoutSession.subscription
            : checkoutSession.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await syncSubscription(subscription, organizationId);
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      await syncSubscription(subscription);
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionField = (invoice as unknown as { subscription?: string | Stripe.Subscription | null })
        .subscription;
      const subscriptionId = typeof subscriptionField === "string" ? subscriptionField : subscriptionField?.id;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await syncSubscription(subscription);
      }
      break;
    }

    default:
      // Every other event type is either not billing-relevant to this app
      // or already covered by one of the cases above.
      break;
  }

  return NextResponse.json({ received: true });
}

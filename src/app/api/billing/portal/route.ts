import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getOrganizationById } from "@/lib/organizations";
import { isStripeConfigured } from "@/lib/config";
import { getStripeClient } from "@/lib/stripe";

// Stripe's own hosted "manage my subscription" screen — update payment
// method, switch tier, cancel, view invoices. Nothing here is built
// custom; Stripe owns that whole UI once a customer exists.
export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing isn't configured on this deployment yet." }, { status: 400 });
  }

  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const org = await getOrganizationById(session.organizationId);
  if (!org?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No Stripe customer on file yet — subscribe to a plan first." },
      { status: 400 }
    );
  }

  const stripe = getStripeClient();
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: `${req.nextUrl.origin}/billing`,
  });

  return NextResponse.json({ url: portalSession.url });
}

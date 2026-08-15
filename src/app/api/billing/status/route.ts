import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getOrganizationById } from "@/lib/organizations";
import { isDefaultOrg } from "@/lib/credentials";
import { getPmsProvider } from "@/lib/pms/registry";
import { PRICING_TIERS, getTierForPropertyCount, isOrgLocked, ENTERPRISE_MIN_PROPERTIES } from "@/lib/billing";
import { isStripeConfigured } from "@/lib/config";

// Feeds the /billing page's client component: current subscription state
// plus a live property count (read through the PMS abstraction layer —
// see lib/pms/registry.ts — so this keeps working unchanged the day a
// second PMS adapter exists) used to suggest which tier fits.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const org = await getOrganizationById(session.organizationId);
  if (!org) return NextResponse.json({ error: "Organization not found." }, { status: 404 });

  let propertyCount: number | null = null;
  try {
    const provider = await getPmsProvider(session.organizationId);
    const properties = await provider.getTargetProperties(session.organizationId);
    propertyCount = properties.length;
  } catch {
    // Brand-new trial with no PMS credentials connected yet, or the PMS is
    // temporarily unreachable — the billing page just skips the
    // "recommended for you" nudge in that case.
  }

  const recommended = propertyCount !== null ? getTierForPropertyCount(propertyCount) : null;

  return NextResponse.json({
    plan: org.plan,
    subscriptionStatus: org.subscriptionStatus,
    trialEndsAt: org.trialEndsAt,
    billingInterval: org.billingInterval,
    locked: isOrgLocked(org),
    stripeConfigured: isStripeConfigured(),
    // Only the platform's own org (Legacy Estate Rentals) manages coupons —
    // see api/billing/coupons/route.ts's requireOperator for the actual
    // enforcement; this just tells the UI whether to show that tab at all.
    isOperator: await isDefaultOrg(session.organizationId),
    propertyCount,
    recommendedTierId: recommended === "enterprise" ? "enterprise" : (recommended?.id ?? null),
    enterpriseMinProperties: ENTERPRISE_MIN_PROPERTIES,
    tiers: PRICING_TIERS.map((t) => ({
      id: t.id,
      name: t.name,
      minProperties: t.minProperties,
      maxProperties: t.maxProperties,
      monthlyPriceCents: t.monthlyPriceCents,
      annualPriceCents: t.annualPriceCents,
    })),
  });
}

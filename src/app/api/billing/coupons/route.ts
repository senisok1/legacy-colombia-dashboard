import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { isDefaultOrg } from "@/lib/credentials";
import { isStripeConfigured } from "@/lib/config";
import { createPromotionCode, listPromotionCodes, setPromotionCodeActive, type CouponInput } from "@/lib/coupons";

// Coupon management is a platform-operator action, not a per-tenant
// self-service one — a tenant should never be able to grant *itself* a
// discount. Gated to only the platform's own default org (same isDefaultOrg
// check lib/credentials.ts uses to scope the Phase 3 credential-fallback)
// rather than a role check, since every organization's CEO role is scoped
// to their own tenant, not the whole platform.
async function requireOperator(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return { error: NextResponse.json({ error: "Not signed in." }, { status: 401 }) } as const;
  }
  if (!(await isDefaultOrg(session.organizationId))) {
    return { error: NextResponse.json({ error: "Not authorized." }, { status: 403 }) } as const;
  }
  return { session } as const;
}

export async function GET(req: NextRequest) {
  const gate = await requireOperator(req);
  if (gate.error) return gate.error;
  if (!isStripeConfigured()) return NextResponse.json({ codes: [] });

  const codes = await listPromotionCodes();
  return NextResponse.json({ codes });
}

export async function POST(req: NextRequest) {
  const gate = await requireOperator(req);
  if (gate.error) return gate.error;
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing isn't configured on this deployment yet." }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as CouponInput | null;
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  try {
    const code = await createPromotionCode(body);
    return NextResponse.json({ code });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Couldn't create the coupon." },
      { status: 400 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOperator(req);
  if (gate.error) return gate.error;
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Billing isn't configured on this deployment yet." }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as { id?: string; active?: boolean } | null;
  if (!body?.id || typeof body.active !== "boolean") {
    return NextResponse.json({ error: "id and active are required." }, { status: 400 });
  }

  await setPromotionCodeActive(body.id, body.active);
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { recordEnterpriseInquiry } from "@/lib/enterpriseInquiries";

// The "talk to sales" path for 101+ properties (see lib/billing.ts's
// ENTERPRISE_MIN_PROPERTIES) — no Stripe Checkout involved at all. Works
// whether or not the requester is logged in, since a prospect sizing up
// the product before signing up should be able to reach this too.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);

  const body = (await req.json().catch(() => null)) as
    | { name?: string; email?: string; propertyCount?: number; message?: string }
    | null;

  const name = body?.name?.trim();
  const email = body?.email?.trim();
  if (!name) return NextResponse.json({ error: "Name is required." }, { status: 400 });
  if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });

  await recordEnterpriseInquiry({
    organizationId: session?.organizationId,
    name,
    email,
    propertyCount: typeof body?.propertyCount === "number" ? body.propertyCount : undefined,
    message: body?.message?.trim() || undefined,
  });

  return NextResponse.json({ ok: true });
}

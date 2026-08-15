import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createBill, listBills } from "@/lib/billPay";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Tracking/detection only — see lib/billPay.ts's header comment. POST here
// creates a bill record and runs duplicate detection; it never schedules or
// sends a payment.
export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ bills: [] });
  const session = getSessionFromRequest(req);
  const bills = await listBills(session?.organizationId);
  return NextResponse.json({ bills });
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const body = await req.json().catch(() => null);
  if (!body?.vendorId || typeof body.amountCents !== "number" || body.amountCents <= 0) {
    return NextResponse.json({ error: "vendorId and a positive amountCents are required." }, { status: 400 });
  }
  const bill = await createBill(body, session?.organizationId);
  return NextResponse.json({ bill });
}

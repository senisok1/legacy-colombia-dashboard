import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createVendor, listVendors } from "@/lib/billPay";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ vendors: [] });
  const session = getSessionFromRequest(req);
  const vendors = await listVendors(session?.organizationId);
  return NextResponse.json({ vendors });
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const body = await req.json().catch(() => null);
  if (!body?.name) {
    return NextResponse.json({ error: "Vendor name is required." }, { status: 400 });
  }
  const vendor = await createVendor(body, session?.organizationId);
  return NextResponse.json({ vendor });
}

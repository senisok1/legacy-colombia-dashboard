import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { updateVendor } from "@/lib/billPay";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  const vendor = await updateVendor(id, body, session?.organizationId);
  if (!vendor) return NextResponse.json({ error: "Vendor not found." }, { status: 404 });
  return NextResponse.json({ vendor });
}

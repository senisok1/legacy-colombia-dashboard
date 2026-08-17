import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createVendor, listVendors } from "@/lib/billPay";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ vendors: [] });
  const session = getSessionFromRequest(req);
  const vendors = await listVendors(session?.organizationId, effectivePropertyGroupId(
      req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
      (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
    ));
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
  // Stamped with the active property so the vendor only shows there (2026-08-17).
  const vendor = await createVendor(body, session?.organizationId, await (async () =>
    effectivePropertyGroupId(
      req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
      (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
    ))());
  return NextResponse.json({ vendor });
}

import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createWorkOrder, listWorkOrders } from "@/lib/maintenance";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

/** The property group this request is actually allowed to act on
 * (2026-08-17 scoping fix). The switcher cookie is only a request — it is
 * re-checked against the viewer's own propertyAccess, so a restricted login
 * can't read or write another property's work orders by editing a cookie.
 * Same shape as api/bills/route.ts. */
async function requestGroupId(req: NextRequest, email: string | undefined): Promise<string> {
  const viewer = await getUserByEmail(email ?? "").catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
}

// Maintenance (Phase 3 gap, tracking only — see lib/maintenance.ts's header
// comment). POST here creates a work order at status 'open'; it never pages
// a vendor or contacts a guest — see lib/serviceRequestNotify.ts for the one
// place that actually notifies anyone (Gabriel).
export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ workOrders: [] });
  const session = getSessionFromRequest(req);
  // Was org-wide: every property's Maintenance tab showed the same work
  // orders (2026-08-17).
  const workOrders = await listWorkOrders(session?.organizationId, await requestGroupId(req, session?.email));
  return NextResponse.json({ workOrders });
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const body = await req.json().catch(() => null);
  if (!body?.title) {
    return NextResponse.json({ error: "title is required." }, { status: 400 });
  }
  // Stamp the active group on the row (2026-08-17). Without this the work
  // order is written with property_group_id NULL, which propertyGroupFilter()
  // reads as "Legacy Colombia" — an issue logged while viewing Legacy Alva
  // would disappear from Alva and surface under Colombia instead.
  const workOrder = await createWorkOrder(
    { ...body, propertyGroupId: await requestGroupId(req, session?.email) },
    session?.organizationId
  );
  return NextResponse.json({ workOrder });
}

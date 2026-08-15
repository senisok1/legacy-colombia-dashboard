import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createWorkOrder, listWorkOrders } from "@/lib/maintenance";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Maintenance (Phase 3 gap, tracking only — see lib/maintenance.ts's header
// comment). POST here creates a work order at status 'open'; it never pages
// a vendor or contacts a guest — see lib/serviceRequestNotify.ts for the one
// place that actually notifies anyone (Gabriel).
export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ workOrders: [] });
  const session = getSessionFromRequest(req);
  const workOrders = await listWorkOrders(session?.organizationId);
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
  const workOrder = await createWorkOrder(body, session?.organizationId);
  return NextResponse.json({ workOrder });
}

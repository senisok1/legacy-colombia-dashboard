import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createLead, listLeads } from "@/lib/leads";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Sales Pipeline (Phase 6, tracking/prioritization only — see lib/leads.ts's
// header comment). POST here creates a lead at stage 'new'; it never sends
// anything to a guest or touches OwnerRez.
export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ leads: [] });
  const session = getSessionFromRequest(req);
  const leads = await listLeads(session?.organizationId);
  return NextResponse.json({ leads });
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const body = await req.json().catch(() => null);
  if (!body?.guestName) {
    return NextResponse.json({ error: "guestName is required." }, { status: 400 });
  }
  const lead = await createLead(body, session?.organizationId);
  return NextResponse.json({ lead });
}

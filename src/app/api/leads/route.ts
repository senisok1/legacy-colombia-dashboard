import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { createLead, listLeads } from "@/lib/leads";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

/** The property group this request is actually allowed to act on
 * (2026-08-17 scoping fix). The switcher cookie is only a request — it is
 * re-checked against the viewer's own propertyAccess, so a restricted login
 * can't read or write another property's pipeline by editing a cookie. Same
 * shape as api/bills/route.ts. */
async function requestGroupId(req: NextRequest, email: string | undefined): Promise<string> {
  const viewer = await getUserByEmail(email ?? "").catch(() => null);
  return effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
}

// Sales Pipeline (Phase 6, tracking/prioritization only — see lib/leads.ts's
// header comment). POST here creates a lead at stage 'new'; it never sends
// anything to a guest or touches OwnerRez.
export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ leads: [] });
  const session = getSessionFromRequest(req);
  // Was org-wide: every property's Sales Pipeline showed the same leads
  // (2026-08-17).
  const leads = await listLeads(session?.organizationId, await requestGroupId(req, session?.email));
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
  // Stamp the active group on the row (2026-08-17). Without this the lead is
  // written with property_group_id NULL, which propertyGroupFilter() reads as
  // "Legacy Colombia" — a lead added while viewing Legacy Miami would vanish
  // from Miami and appear in Colombia's pipeline.
  const lead = await createLead(
    { ...body, propertyGroupId: await requestGroupId(req, session?.email) },
    session?.organizationId
  );
  return NextResponse.json({ lead });
}

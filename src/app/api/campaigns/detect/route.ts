import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { detectCandidates } from "@/lib/lifecycleMarketing";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Shared by the daily cron (api/cron/detect-campaigns, which is the
// CRON_SECRET-guarded entry point) and the "Scan now" button on the CRM
// Campaigns tab (reached only via the logged-in dashboard session, same
// protection as every other /api route here — see proxy.ts).
//
// PROPERTY SCOPING FIX (2026-08-18, Seni: "still seeing Legacy Colombia data
// in the Campaigns dropdown ... for Legacy Alva"). The 2026-08-17 pass fixed
// the daily cron (api/cron/detect-campaigns loops every property group and
// passes its id through) and the GET /api/campaigns read (scoped by cookie),
// but this manual "Scan now" button was missed: it called
// getGuests(organizationId)/getBookings(organizationId) and
// detectCandidates(..., organizationId) with NO propertyGroupId, which
// silently resolves to Legacy Colombia (propertyGroupById(undefined) falls
// back to PROPERTY_GROUPS[0]) regardless of which property tab the click came
// from, and stamps the resulting candidates with property_group_id = NULL —
// which the default-group query (`= 'legacy-colombia' OR IS NULL`) then
// shows under Colombia. Net effect: clicking Scan on ANY property actually
// scanned Colombia's guests, and only Colombia's Campaigns tab ever grew from
// it. Now resolved the same way GET /api/campaigns does.
async function runDetection(organizationId?: string, propertyGroupId?: string) {
  const [guests, bookings] = await Promise.all([
    getGuests(organizationId, propertyGroupId),
    getBookings(organizationId, propertyGroupId),
  ]);
  return detectCandidates(guests, bookings, organizationId, propertyGroupId);
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  try {
    const viewer = await getUserByEmail(session?.email ?? "").catch(() => null);
    const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
    const result = await runDetection(session?.organizationId, groupId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 }
    );
  }
}

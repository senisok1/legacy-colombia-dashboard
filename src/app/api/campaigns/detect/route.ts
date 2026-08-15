import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { detectCandidates } from "@/lib/lifecycleMarketing";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Shared by the daily cron (api/cron/detect-campaigns, which is the
// CRON_SECRET-guarded entry point) and the "Scan now" button on the CRM
// Campaigns tab (reached only via the logged-in dashboard session, same
// protection as every other /api route here — see proxy.ts).
async function runDetection(organizationId?: string) {
  const [guests, bookings] = await Promise.all([getGuests(organizationId), getBookings(organizationId)]);
  return detectCandidates(guests, bookings, organizationId);
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  try {
    const result = await runDetection(session?.organizationId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 }
    );
  }
}

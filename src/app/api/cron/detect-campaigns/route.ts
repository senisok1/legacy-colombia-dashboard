import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { detectCandidates } from "@/lib/lifecycleMarketing";
import { listActiveOrganizations } from "@/lib/organizations";

// Daily scan for new lifecycle-marketing candidates (win-back, referral,
// abandoned-booking) — see lib/lifecycleMarketing.ts's header comment. Runs
// once a day via vercel.json's cron entry, same pattern as
// api/cron/revenue-snapshot. Only ever CREATES 'candidate' rows for Seni to
// review in the CRM Campaigns tab — never sends anything itself.
//
// Phase 3: loops over every organization in good standing (trialing/active
// subscription — see listActiveOrganizations) rather than running once for
// the single default org, so each tenant's own OwnerRez data gets scanned
// with their own credentials. One org's failure is isolated and reported
// per-org rather than aborting the whole run.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Vercel signs its own cron requests with this header when CRON_SECRET is
  // set — same guard as the other cron routes.
  if (config.cronSecret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${config.cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ skipped: "Database isn't connected yet." });
  }

  const orgs = await listActiveOrganizations();
  const results: Record<string, unknown> = {};

  for (const org of orgs) {
    try {
      const [guests, bookings] = await Promise.all([getGuests(org.id), getBookings(org.id)]);
      const result = await detectCandidates(guests, bookings, org.id);
      results[org.slug] = { ok: true, ...result };
    } catch (err) {
      console.error(`[cron/detect-campaigns] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}

import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { detectCandidates } from "@/lib/lifecycleMarketing";
import { listActiveOrganizations } from "@/lib/organizations";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";

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
// Raised from 60s 2026-08-17: this now runs detection for EVERY property
// rather than once for the default one, and each pass does live OwnerRez
// fetches plus AI drafting per candidate. At 60s a five-property run would
// have been cut off partway, silently leaving later properties undetected.
export const maxDuration = 300;

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
      // PER-PROPERTY DETECTION (2026-08-17). This previously ran once per
      // organization with unscoped getGuests/getBookings — which defaulted to
      // Legacy Colombia — and wrote candidates with no property tag, so the
      // Campaigns tab showed Colombia's past guests under every property.
      // Now each property is detected separately and its candidates are
      // stamped with that property, so a new property with few past guests
      // correctly shows few candidates.
      const perProperty: Record<string, unknown> = {};
      for (const group of PROPERTY_GROUPS) {
        try {
          const [guests, bookings] = await Promise.all([
            getGuests(org.id, group.id),
            getBookings(org.id, group.id),
          ]);
          perProperty[group.id] = await detectCandidates(guests, bookings, org.id, group.id);
        } catch (groupErr) {
          // One property failing shouldn't stop the others being detected.
          console.error(`[cron/detect-campaigns] ${org.slug}/${group.id} failed`, groupErr);
          perProperty[group.id] = {
            error: groupErr instanceof Error ? groupErr.message : "Unknown error.",
          };
        }
      }
      results[org.slug] = { ok: true, perProperty };
    } catch (err) {
      console.error(`[cron/detect-campaigns] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}

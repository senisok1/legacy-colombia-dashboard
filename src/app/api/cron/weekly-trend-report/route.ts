import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { buildTrendReport, deliverTrendReport } from "@/lib/trendReport";
import { listActiveOrganizations } from "@/lib/organizations";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";

// Weekly trend report (see lib/trendReport.ts's header comment) — runs once
// a week via vercel.json's cron entry, same guard pattern as
// api/cron/daily-report. Scheduled Monday morning, shortly after that day's
// daily-report run, so Seni gets both the daily snapshot and the
// week/month-over-week direction-of-travel read back to back.
//
// Phase 3: loops over every organization in good standing (trialing/active
// subscription — see listActiveOrganizations) rather than running once for
// the single default org, so each tenant gets their own trend report built
// and delivered from their own data. One org's failure is isolated and
// reported per-org rather than aborting the whole run.
//
// PER-PROPERTY REPORTS (2026-08-17 audit): this previously called
// buildTrendReport(org.id) with NO property group, so it built and delivered
// ONE report from Legacy Colombia's bookings only — the trend numbers for
// Alva, Pompano, Miami and Beach House were never computed or sent. Now it
// iterates every property group and builds + delivers one report per
// property (the same "iterate per group" shape daily-report uses), each with
// its own try/catch so one property's failure doesn't cost the others their
// report.
//
// KNOWN LIB LIMITATION (reported, not fixed here — out of scope): unlike
// deliverExecutiveReport, deliverTrendReport() takes no propertyGroupId/label,
// and its email subject is hardcoded to "Legacy Colombia" (lib/trendReport.ts
// ~line 246). So while the BODY numbers below are now correctly per-property,
// every property's email currently arrives under a "Legacy Colombia" subject.
// The property is disambiguated only via the `trigger` string (which lands in
// the ai_activity log, not the email). Fixing the subject needs a lib change
// to deliverTrendReport — see this task's report.
// Raised from 60s to 120s: five per-property builds each paginate live
// OwnerRez bookings, so give headroom rather than risk a mid-run timeout.
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  // CRON AUTH — FAIL CLOSED IN PRODUCTION (2026-08-17 audit). See the matching
  // guard in api/cron/detect-reviews for the full reasoning: a missing
  // CRON_SECRET used to silently run this endpoint open; it now rejects in
  // production and only runs unauthenticated in non-production.
  const isProd = process.env.VERCEL_ENV === "production";
  if (!config.cronSecret) {
    if (isProd) {
      console.error(
        "[cron/weekly-trend-report] CRON_SECRET is not set in production — refusing to run this endpoint unauthenticated. Set CRON_SECRET in Vercel."
      );
      return NextResponse.json({ error: "Cron not configured." }, { status: 503 });
    }
    console.warn("[cron/weekly-trend-report] CRON_SECRET unset — running WITHOUT auth (non-production only).");
  } else {
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
      // Per-property fan-out — see the header note. One report built and
      // delivered per property group.
      const perProperty: Record<string, unknown> = {};
      for (const group of PROPERTY_GROUPS) {
        try {
          const report = await buildTrendReport(org.id, group.id);
          const delivery = await deliverTrendReport(
            report,
            `Scheduled Monday 9:20am ET run — ${group.label}`,
            org.id,
            group.label
          );
          perProperty[group.id] = { ok: true, delivery, report };
        } catch (groupErr) {
          // One property failing must not cost the others their report.
          console.error(`[cron/weekly-trend-report] ${org.slug}/${group.id} failed`, groupErr);
          perProperty[group.id] = {
            ok: false,
            error: groupErr instanceof Error ? groupErr.message : "Unknown error.",
          };
        }
      }
      results[org.slug] = { ok: true, perProperty };
    } catch (err) {
      console.error(`[cron/weekly-trend-report] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}

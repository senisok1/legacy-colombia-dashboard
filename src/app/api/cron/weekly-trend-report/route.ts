import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { buildTrendReport, deliverTrendReport } from "@/lib/trendReport";
import { listActiveOrganizations } from "@/lib/organizations";

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
export const maxDuration = 60;

export async function GET(req: NextRequest) {
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
      const report = await buildTrendReport(org.id);
      const delivery = await deliverTrendReport(report, "Scheduled Monday 9:20am ET run", org.id);
      results[org.slug] = { ok: true, delivery, report };
    } catch (err) {
      console.error(`[cron/weekly-trend-report] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}

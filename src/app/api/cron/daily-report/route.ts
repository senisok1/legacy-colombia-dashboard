import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { buildExecutiveReport, deliverExecutiveReport } from "@/lib/executiveReport";
import { listActiveOrganizations } from "@/lib/organizations";

// Phase 8 of the Legacy AI Company roadmap (docs/VISION.md) — the Data
// Analyst agent's 5am ET daily executive report, pushed to Seni over
// WhatsApp and email (see lib/executiveReport.ts's deliverExecutiveReport —
// each channel is independent, so one failing never blocks the other).
// Runs once a day via vercel.json's cron entry, same guard pattern as
// api/cron/revenue-snapshot and api/cron/detect-campaigns. Scheduled a few
// minutes after revenue-snapshot's 9:00 UTC run so this report reflects
// that day's freshest rate-shadow data too.
//
// Phase 3: loops over every organization in good standing (trialing/active
// subscription — see listActiveOrganizations) rather than running once for
// the single default org, so each tenant gets their own report built and
// delivered from their own data. One org's failure is isolated and reported
// per-org rather than aborting the whole run.
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
      const report = await buildExecutiveReport(org.id);
      const delivery = await deliverExecutiveReport(report, "Scheduled 5:10am ET run", org.id);
      results[org.slug] = { ok: true, delivery, report };
    } catch (err) {
      console.error(`[cron/daily-report] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}

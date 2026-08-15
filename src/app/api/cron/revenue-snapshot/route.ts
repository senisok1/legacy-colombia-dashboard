import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { runDailyRateSnapshot, runAutoApplyPass } from "@/lib/revenueManager";
import { listActiveOrganizations } from "@/lib/organizations";

// Daily shadow-mode rate comparison — see lib/revenueManager.ts's header
// comment. Runs once a day via vercel.json's cron entry (Hobby-plan
// compatible; unlike the WhatsApp check-messages poller this doesn't need
// sub-minute cadence, so no external cron-job.org pinger is needed here).
// Raised from 60s to 120s when the snapshot was extended to full calendar
// coverage (2026-08-04, ~5-8x more dates than the original 13) — the
// concurrency-bounded fan-out in runDailyRateSnapshot keeps this well under
// budget in practice, but the higher ceiling gives headroom for a slow
// OwnerRez/Anthropic day rather than the run getting killed mid-write.
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  // Vercel signs its own cron requests with this header when CRON_SECRET is
  // set — same guard as api/cron/check-messages.
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
      const result = await runDailyRateSnapshot(org.id);
      // Auto-apply band (Phase 5c) — always safe to call: no-ops (enabled:false)
      // unless Seni has explicitly set REVENUE_AUTO_APPLY_ENABLED=true. See
      // lib/revenueManager.ts's runAutoApplyPass() header comment.
      const autoApply = await runAutoApplyPass(org.id).catch((err) => ({
        enabled: false as const,
        bandPct: config.revenueAutoApplyBandPct,
        candidatesConsidered: 0,
        applied: [],
        skippedAlreadyAppliedToday: 0,
        errors: [{ stayDate: "n/a", error: err instanceof Error ? err.message : "Unknown error." }],
      }));
      results[org.slug] = { ok: true, ...result, autoApply };
    } catch (err) {
      console.error(`[cron/revenue-snapshot] failed for org ${org.slug}`, err);
      results[org.slug] = { ok: false, error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  return NextResponse.json({ ok: true, organizations: results });
}

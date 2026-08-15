import { NextRequest, NextResponse } from "next/server";
import { buildTrendReport, deliverTrendReport } from "@/lib/trendReport";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Manual trigger for the weekly trend report (see lib/trendReport.ts),
// mirroring api/debug/send-test-report's pattern exactly — reached through
// the normal dashboard session, not CRON_SECRET. Lets Seni fire a real
// WhatsApp + email send right now instead of waiting for Monday morning.
//
// Phase 3: same fix as send-test-report — scope build + delivery to the
// logged-in session's own organizationId instead of always the default org.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  try {
    const report = await buildTrendReport(session?.organizationId);
    const delivery = await deliverTrendReport(
      report,
      "Manual test send from dashboard",
      session?.organizationId
    );
    return NextResponse.json({ ok: true, delivery, report });
  } catch (err) {
    return NextResponse.json(
      { error: `Test send failed: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}

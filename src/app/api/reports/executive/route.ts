import { NextRequest, NextResponse } from "next/server";
import { buildExecutiveReport } from "@/lib/executiveReport";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Phase 8 — on-demand version of the same report the daily cron pushes to
// WhatsApp (api/cron/daily-report). Powers the Reports tab's summary
// section so Seni can pull a fresh read any time, not just at 5am ET.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  try {
    const report = await buildExecutiveReport(session?.organizationId);
    return NextResponse.json({ report });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to build report: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}

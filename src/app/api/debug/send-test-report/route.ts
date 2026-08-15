import { NextRequest, NextResponse } from "next/server";
import { buildExecutiveReport, deliverExecutiveReport } from "@/lib/executiveReport";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// TEMPORARY-ISH manual trigger for the Phase 8 daily report — reached
// through the normal dashboard session (not CRON_SECRET, which Vercel
// manages itself and isn't a value this sandbox can retrieve — see
// project_vercel_sensitive_db_secret memory). /api/debug/* isn't in
// proxy.ts's bypass list, so this is exactly as protected as the rest of
// the dashboard. Lets Seni (or Claude, with his go-ahead) fire a real
// WhatsApp + email send right now instead of waiting for 5:10am ET, e.g. to
// confirm a newly-configured channel actually works end to end.
//
// Phase 3: this used to build/deliver the DEFAULT org's report regardless of
// who was actually logged in — any tenant hitting this debug button would
// trigger a real send of Legacy Colombia's report to Legacy Colombia's own
// WhatsApp/email. Now scoped to the logged-in session's own organizationId.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  try {
    const report = await buildExecutiveReport(session?.organizationId);
    const delivery = await deliverExecutiveReport(
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

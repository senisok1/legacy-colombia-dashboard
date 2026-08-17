import { NextRequest, NextResponse } from "next/server";
import { buildExecutiveReport } from "@/lib/executiveReport";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// Phase 8 — on-demand version of the same report the daily cron pushes to
// WhatsApp (api/cron/daily-report). Powers the Reports tab's summary
// section so Seni can pull a fresh read any time, not just at 5am ET.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  // SECURITY FIX (2026-08-17 audit): this had no auth check at all and no
  // property group. A READ_ONLY team session could fetch whole-portfolio
  // financials for all five properties — the Reports PAGE was blocked, this
  // API wasn't — and a restricted owner got every property's numbers rather
  // than only the ones they're granted.
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });
  if (session.role !== "CEO") {
    return NextResponse.json({ error: "This report is admin-only." }, { status: 403 });
  }
  try {
    const viewer = await getUserByEmail(session.email).catch(() => null);
    const groupId = effectivePropertyGroupId(
      req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
      viewer?.propertyAccess
    );
    const report = await buildExecutiveReport(session.organizationId, groupId);
    return NextResponse.json({ report });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to build report: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }
}

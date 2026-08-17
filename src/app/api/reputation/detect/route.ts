import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { detectAndDraftResponses } from "@/lib/reputationManager";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Same detection logic as the daily cron (api/cron/detect-reviews, which
// calls detectAndDraftResponses directly and is gated by CRON_SECRET) — this
// route is the "Scan now" button on the Reputation tab, same pattern as
// api/campaigns/detect. It isn't itself CRON_SECRET-gated, and if hit with no
// logged-in session, session is simply null and detectAndDraftResponses
// falls back to the default org, same as before this route knew about
// sessions at all.
export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  try {
    const result = await detectAndDraftResponses(session?.organizationId, effectivePropertyGroupId(
      req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
      (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
    ));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { getLatestRateSnapshots, getLatestRateOverrides } from "@/lib/revenueManager";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

// Read-only — powers the Revenue Management tab's table + "Applied" badges.
// The only write path for rates anywhere in this app lives in
// api/revenue/apply/route.ts (see that file and lib/revenueManager.ts's
// applyRateOverride() for what it does and why it's approval-gated).
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const [snapshots, overrides] = await Promise.all([
    getLatestRateSnapshots(session?.organizationId),
    getLatestRateOverrides(session?.organizationId),
  ]);
  return NextResponse.json({ snapshots, overrides });
}

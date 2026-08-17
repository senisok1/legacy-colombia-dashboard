import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { getLatestRateSnapshots, getLatestRateOverrides } from "@/lib/revenueManager";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

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
  // Property scoping (2026-08-17). Both calls were org-wide, so the Revenue
  // Management table listed every property's rate snapshots and showed
  // "Applied" badges from overrides belonging to other listings. The switcher
  // cookie is only a request — effectivePropertyGroupId() re-checks it
  // against the viewer's propertyAccess so a restricted login can't read
  // another property's rates. Same shape as api/bills/route.ts. Snapshots and
  // overrides must share one group id or the badges wouldn't line up with the
  // rows they annotate.
  const viewer = await getUserByEmail(session?.email ?? "").catch(() => null);
  const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const [snapshots, overrides] = await Promise.all([
    getLatestRateSnapshots(session?.organizationId, groupId),
    getLatestRateOverrides(session?.organizationId, groupId),
  ]);
  return NextResponse.json({ snapshots, overrides });
}

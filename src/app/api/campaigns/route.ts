import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { listCampaignCandidates } from "@/lib/lifecycleMarketing";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) return NextResponse.json({ candidates: [] });
  const session = getSessionFromRequest(req);
  // Property scoping (2026-08-17). This was org-wide, so the lifecycle
  // marketing tab offered every property's past guests as campaign candidates
  // no matter which property was selected. The switcher cookie is only a
  // request — effectivePropertyGroupId() re-checks it against the viewer's
  // propertyAccess so a restricted login can't pull another property's guest
  // list. Same shape as api/bills/route.ts.
  const viewer = await getUserByEmail(session?.email ?? "").catch(() => null);
  const candidates = await listCampaignCandidates(
    session?.organizationId,
    effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess)
  );
  return NextResponse.json({ candidates });
}

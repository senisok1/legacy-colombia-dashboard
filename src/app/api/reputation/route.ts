import { NextRequest, NextResponse } from "next/server";
import { listReputationEntries } from "@/lib/reputationManager";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const entries = await listReputationEntries(session?.organizationId, effectivePropertyGroupId(
      req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
      (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
    ));
  return NextResponse.json({ entries });
}

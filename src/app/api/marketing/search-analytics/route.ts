import { NextRequest, NextResponse } from "next/server";
import {
  getSearchConsolePerformance,
  getGa4Overview,
  gscSiteUrlFor,
  ga4PropertyIdFor,
} from "@/lib/searchAnalytics";
import { getSessionFromRequest } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// Per-property Search Console / GA4 (2026-08-17, Seni: "For the Legacy Alva
// marketing seo/analytics panel, pull that data from Legacy Alva's specific
// website www.legacyalva.com"). The site/property is resolved from the
// active property group, so a property with nothing connected returns null
// rather than another property's traffic.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const groupId = effectivePropertyGroupId(
    req.cookies.get(PROPERTY_GROUP_COOKIE)?.value,
    (await getUserByEmail(session?.email ?? "").catch(() => null))?.propertyAccess
  );

  const [gsc, ga4] = await Promise.all([
    gscSiteUrlFor(groupId)
      ? getSearchConsolePerformance(28, groupId).catch((err) => ({
          error: err instanceof Error ? err.message : String(err),
        }))
      : null,
    ga4PropertyIdFor(groupId)
      ? getGa4Overview(28, groupId).catch((err) => ({
          error: err instanceof Error ? err.message : String(err),
        }))
      : null,
  ]);
  return NextResponse.json({ gsc, ga4 });
}

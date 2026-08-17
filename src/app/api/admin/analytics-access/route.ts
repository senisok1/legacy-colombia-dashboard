import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import {
  gscSiteUrlFor,
  ga4PropertyIdFor,
  getSearchConsolePerformance,
  getGa4Overview,
} from "@/lib/searchAnalytics";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";

export const dynamic = "force-dynamic";

// Shows which Search Console site / GA4 property each property is wired to,
// plus the service-account email that has to be granted access on each one
// (2026-08-17). The client_email is NOT a secret — it's the address you add
// as a user in Search Console / GA4 — but the private key it belongs to is,
// so this only ever returns the email and never the key itself.
//
//   GET /api/admin/analytics-access?secret=…
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let serviceAccountEmail: string | null = null;
  try {
    const parsed = JSON.parse(config.googleServiceAccountKey || "{}") as { client_email?: string };
    serviceAccountEmail = parsed.client_email ?? null;
  } catch {
    serviceAccountEmail = null;
  }

  // ?test=<groupId> actually CALLS Google for that property, rather than just
  // reporting what's configured (2026-08-17). Configuration being present
  // proves nothing — the service account also has to have been granted
  // access on the Google side, which is a manual step by whoever owns the
  // property.
  const testGroup = req.nextUrl.searchParams.get("test");
  if (testGroup) {
    const [gsc, ga4] = await Promise.all([
      gscSiteUrlFor(testGroup)
        ? getSearchConsolePerformance(28, testGroup).then(
            (r) => ({ ok: true, ...r }),
            (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })
          )
        : Promise.resolve({ ok: false, error: "No Search Console site configured for this property." }),
      ga4PropertyIdFor(testGroup)
        ? getGa4Overview(28, testGroup).then(
            (r) => ({ ok: true, ...r }),
            (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })
          )
        : Promise.resolve({ ok: false, error: "No GA4 property configured for this property." }),
    ]);
    return NextResponse.json({
      testedGroup: testGroup,
      searchConsoleSite: gscSiteUrlFor(testGroup) || null,
      ga4PropertyId: ga4PropertyIdFor(testGroup) || null,
      serviceAccountEmail,
      searchConsole: gsc,
      ga4,
    });
  }

  return NextResponse.json({
    serviceAccountEmail,
    properties: PROPERTY_GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      searchConsoleSite: gscSiteUrlFor(g.id) || null,
      ga4PropertyId: ga4PropertyIdFor(g.id) || null,
    })),
  });
}

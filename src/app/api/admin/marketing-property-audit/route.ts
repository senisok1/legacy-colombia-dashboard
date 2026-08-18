import { NextRequest, NextResponse } from "next/server";
import { config, isDbConfigured } from "@/lib/config";
import { query } from "@/lib/db";
import { PROPERTY_GROUPS } from "@/lib/propertyGroups";
import { getDefaultOrganizationId } from "@/lib/organizations";
import { listCampaignCandidates } from "@/lib/lifecycleMarketing";
import { listContentCampaigns } from "@/lib/contentMarketing";
import { gscSiteUrlFor, ga4PropertyIdFor, displaySiteDomain } from "@/lib/searchAnalytics";

export const dynamic = "force-dynamic";

// Marketing-tab property-scoping audit (2026-08-18, Seni: "still seeing
// Legacy Colombia data in the Campaigns dropdown ... for Legacy Alva" +
// "Search & site performance ... scoped only to legacycolombia.com ... for
// all properties"). Two things this checks per property group:
//
// 1. lifecycle_campaign_candidates (the "Campaigns" nav tab, /crm-campaigns)
//    — `viaProductionFilter` uses the exact same query listCampaignCandidates
//    uses in production (including the default group's "= 'legacy-colombia'
//    OR IS NULL" OR-clause), so it shows what a real page load would render.
//    `exactMatch`/`nullTagged` break that down so a NULL-tagged row (created
//    before a property was correctly threaded through, or by the
//    now-fixed detect-candidates bug) is visible instead of hidden inside a
//    combined count.
// 2. Search Console / GA4 config presence per property, plus the exact
//    `siteLabel` string the Search & Site Performance panel will render —
//    proves the panel text is actually per-property now, not just that the
//    code compiles.
//
//   GET /api/admin/marketing-property-audit?secret=…
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!config.adminSecret || secret !== config.adminSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL isn't set." }, { status: 400 });
  }

  const orgId = await getDefaultOrganizationId();

  // Whole-table distribution, independent of any per-group query — so a
  // stray NULL/mistagged row shows up even if no group's filter would
  // surface it as "leaking".
  const rawDistribution = await query<{ property_group_id: string | null; count: string }>(
    `select property_group_id, count(*)::text as count
     from lifecycle_campaign_candidates
     where organization_id = $1
     group by property_group_id
     order by count(*) desc`,
    [orgId]
  );

  const groups = [];
  for (const g of PROPERTY_GROUPS) {
    const viaProductionFilter = await listCampaignCandidates(orgId, g.id);
    const exactMatch = await query<{ count: string }>(
      `select count(*)::text as count from lifecycle_campaign_candidates
       where organization_id = $1 and property_group_id = $2`,
      [orgId, g.id]
    );
    const contentCampaigns = await listContentCampaigns(orgId, g.id);

    const gscSite = gscSiteUrlFor(g.id);
    const ga4Id = ga4PropertyIdFor(g.id);
    const siteLabel = gscSite ? displaySiteDomain(gscSite) : ga4Id ? g.label : "";

    // A candidate whose guest/trigger text plainly names a different
    // property is the clearest possible leak signal — flag any pending
    // (non-history) row here for eyeballing.
    const sample = viaProductionFilter.slice(0, 5).map((c) => ({
      id: c.id,
      guestName: c.guestName,
      campaignType: c.campaignType,
      status: c.status,
      triggerReason: c.triggerReason,
    }));

    groups.push({
      id: g.id,
      label: g.label,
      campaignCandidates: {
        shownOnThisTab: viaProductionFilter.length,
        exactlyTaggedThisProperty: Number(exactMatch[0]?.count ?? 0),
        sample,
      },
      contentCampaigns: contentCampaigns.length,
      searchAnalytics: {
        gscConfigured: Boolean(gscSite),
        ga4Configured: Boolean(ga4Id),
        panelSubtitle: siteLabel
          ? `Live data from Google Search Console${ga4Id ? " and GA4" : ""} — scoped only to ${siteLabel}.`
          : `No Search Console / GA4 site is connected for ${g.label} yet.`,
      },
    });
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    rawCandidateDistribution: rawDistribution.map((r) => ({
      propertyGroupId: r.property_group_id,
      count: Number(r.count),
    })),
    groups,
  });
}

import { isDbConfigured, isPostizConfigured } from "@/lib/config";
import { listContentPieces, listContentCampaigns, listPiecesForCampaign } from "@/lib/contentMarketing";
import { getPushableChannels } from "@/lib/postiz";
import { listMarketingContacts, getMarketingContactStats } from "@/lib/marketingContacts";
import {
  getSearchConsolePerformance,
  getGa4Overview,
  gscSiteUrlFor,
  ga4PropertyIdFor,
  displaySiteDomain,
} from "@/lib/searchAnalytics";
import { getServerSession } from "@/lib/session";
import { cookies } from "next/headers";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, propertyGroupById } from "@/lib/propertyGroups";

import { enforceBillingLock } from "@/lib/billingGate";
import { MarketingExplorer } from "@/components/MarketingExplorer";
import { PageHeader } from "@/components/PageHeader";
import { MARKETING_GROUP_TABS } from "@/lib/navGroups";
import { SocialMediaManager } from "@/components/SocialMediaManager";
import { MarketingContactsPanel } from "@/components/MarketingContactsPanel";
import { SearchAnalyticsPanel } from "@/components/SearchAnalyticsPanel";

export const dynamic = "force-dynamic";

export default async function MarketingPage() {
  if (!isDbConfigured()) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-sm text-black/50 dark:text-white/50">
          Database isn&rsquo;t connected yet, so Marketing isn&rsquo;t available.
        </p>
      </div>
    );
  }

  const session = await getServerSession();
  await enforceBillingLock(session);
  // Property scoping (2026-08-17, Seni: "ensure these tabs show only the
  // specific data for that specific property ONLY").
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const orgId = session?.organizationId;
  const [pieces, campaigns, contacts, contactStats, gsc, ga4] = await Promise.all([
    listContentPieces(orgId, groupId),
    listContentCampaigns(orgId, groupId),
    listMarketingContacts(orgId, groupId),
    getMarketingContactStats(orgId, groupId),
    // Per-property Search Console / GA4 (2026-08-17): Legacy Alva pulls
    // legacyalva.com, not legacycolombia.com. A property with nothing
    // configured shows "not connected" instead of another site's numbers.
    gscSiteUrlFor(groupId)
      ? getSearchConsolePerformance(28, groupId).catch((err) => ({
          error: err instanceof Error ? err.message : String(err),
        }))
      : Promise.resolve(null),
    ga4PropertyIdFor(groupId)
      ? getGa4Overview(28, groupId).catch((err) => ({
          error: err instanceof Error ? err.message : String(err),
        }))
      : Promise.resolve(null),
  ]);
  const campaignsWithPieces = await Promise.all(
    campaigns.map(async (campaign) => ({ campaign, pieces: await listPiecesForCampaign(campaign.id, orgId) }))
  );

  // Site label for the Search & Site Performance panel (2026-08-18, Seni:
  // the panel said "legacycolombia.com" under every property). Prefer the
  // configured GSC domain; if only GA4 is connected for this property, fall
  // back to the property's own label rather than leaving it blank.
  const propertyLabel = propertyGroupById(groupId).label;
  const siteUrlForGroup = gscSiteUrlFor(groupId);
  const siteLabel = siteUrlForGroup
    ? displaySiteDomain(siteUrlForGroup)
    : ga4PropertyIdFor(groupId)
      ? propertyLabel
      : "";

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      {/* Section strip added 2026-08-17 when Campaigns + Pipeline moved
          under Marketing and the CRM group was removed. */}
      <PageHeader
        eyebrow="Marketing"
        title={`Marketing — ${propertyGroupById(groupId).label}`}
        subtitle="Social Media Manager below drafts a full weekly batch from one pillar asset; standalone blog/email ideas are further down. Approving a social piece on a connected Postiz channel stages it as a real draft there — everything else is copy-and-post-yourself until connected."
        tabs={MARKETING_GROUP_TABS}
      />

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <SearchAnalyticsPanel gsc={gsc} ga4={ga4} siteLabel={siteLabel} propertyLabel={propertyLabel} />
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <SocialMediaManager
          initialCampaigns={campaignsWithPieces}
          pushableChannels={getPushableChannels()}
          postizConfigured={isPostizConfigured()}
        />
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <MarketingExplorer initialPieces={pieces} />
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <MarketingContactsPanel initialContacts={contacts} initialStats={contactStats} />
      </div>
    </div>
  );
}

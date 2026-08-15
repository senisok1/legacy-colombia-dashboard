import { isDbConfigured, isSearchAnalyticsConfigured, isGa4Configured, isPostizConfigured } from "@/lib/config";
import { listContentPieces, listContentCampaigns, listPiecesForCampaign } from "@/lib/contentMarketing";
import { getPushableChannels } from "@/lib/postiz";
import { listMarketingContacts, getMarketingContactStats } from "@/lib/marketingContacts";
import { getSearchConsolePerformance, getGa4Overview } from "@/lib/searchAnalytics";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { MarketingExplorer } from "@/components/MarketingExplorer";
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
  const orgId = session?.organizationId;
  const [pieces, campaigns, contacts, contactStats, gsc, ga4] = await Promise.all([
    listContentPieces(orgId),
    listContentCampaigns(orgId),
    listMarketingContacts(orgId),
    getMarketingContactStats(orgId),
    isSearchAnalyticsConfigured()
      ? getSearchConsolePerformance().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      : Promise.resolve(null),
    isGa4Configured()
      ? getGa4Overview().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
      : Promise.resolve(null),
  ]);
  const campaignsWithPieces = await Promise.all(
    campaigns.map(async (campaign) => ({ campaign, pieces: await listPiecesForCampaign(campaign.id, orgId) }))
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Marketing</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Social Media Manager below drafts a full weekly batch from one pillar asset; standalone blog/email ideas
          are further down. Approving a social piece on a connected Postiz channel stages it as a real draft there —
          everything else is copy-and-post-yourself until connected.
        </p>
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <SearchAnalyticsPanel gsc={gsc} ga4={ga4} />
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

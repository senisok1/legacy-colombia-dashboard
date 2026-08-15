import { isDbConfigured } from "@/lib/config";
import { listCampaignCandidates } from "@/lib/lifecycleMarketing";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { CrmCampaignsExplorer } from "@/components/CrmCampaignsExplorer";
import { PageHeader } from "@/components/PageHeader";
import { CRM_GROUP_TABS } from "@/lib/navGroups";

export const dynamic = "force-dynamic";

export default async function CrmCampaignsPage() {
  if (!isDbConfigured()) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-sm text-black/50 dark:text-white/50">
          Database isn&rsquo;t connected yet, so CRM Campaigns isn&rsquo;t available.
        </p>
      </div>
    );
  }

  const session = await getServerSession();
  await enforceBillingLock(session);
  const candidates = await listCampaignCandidates(session?.organizationId);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PageHeader
        eyebrow="CRM"
        title="Campaigns"
        subtitle="Proactive re-engagement for guests who already exist in OwnerRez — win-back, referral asks, and abandoned-booking follow-ups. Tracking + drafting only: every send needs your explicit approval."
        tabs={CRM_GROUP_TABS}
      />

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <CrmCampaignsExplorer initialCandidates={candidates} />
      </div>
    </div>
  );
}

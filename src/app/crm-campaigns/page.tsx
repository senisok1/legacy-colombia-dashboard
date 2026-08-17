import { isDbConfigured } from "@/lib/config";
import { listCampaignCandidates } from "@/lib/lifecycleMarketing";
import { getServerSession } from "@/lib/session";
import { cookies } from "next/headers";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, propertyGroupById } from "@/lib/propertyGroups";
import { enforceBillingLock } from "@/lib/billingGate";
import { CrmCampaignsExplorer } from "@/components/CrmCampaignsExplorer";
import { PageHeader } from "@/components/PageHeader";
import { MARKETING_GROUP_TABS } from "@/lib/navGroups";

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
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const candidates = await listCampaignCandidates(session?.organizationId, groupId);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PageHeader
        eyebrow="Marketing"
        title={`Campaigns — ${propertyGroupById(groupId).label}`}
        subtitle="Proactive re-engagement for guests who already exist in OwnerRez — win-back, referral asks, and abandoned-booking follow-ups. Tracking + drafting only: every send needs your explicit approval."
        tabs={MARKETING_GROUP_TABS}
      />

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <CrmCampaignsExplorer initialCandidates={candidates} />
      </div>
    </div>
  );
}

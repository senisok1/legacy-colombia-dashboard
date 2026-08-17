import { config, isDbConfigured } from "@/lib/config";
import { getLatestRateSnapshots, getLatestRateOverrides } from "@/lib/revenueManager";
import { getServerSession } from "@/lib/session";
import { cookies } from "next/headers";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, propertyGroupById } from "@/lib/propertyGroups";
import { enforceBillingLock } from "@/lib/billingGate";
import { RevenueManagementExplorer } from "@/components/RevenueManagementExplorer";

export const dynamic = "force-dynamic";

export default async function RevenueManagementPage() {
  if (!isDbConfigured()) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-sm text-black/50 dark:text-white/50">
          Database isn&rsquo;t connected yet, so AI Pricing isn&rsquo;t available.
        </p>
      </div>
    );
  }

  const session = await getServerSession();
  await enforceBillingLock(session);
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const orgId = session?.organizationId;
  const [snapshots, overrides] = await Promise.all([
    getLatestRateSnapshots(orgId, groupId),
    getLatestRateOverrides(orgId, groupId),
  ]);
  const autoApplyOn = config.revenueAutoApplyEnabled;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">AI Pricing — {propertyGroupById(groupId).label}</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Occupancy/ADR rate recommendations. Review a night, edit the price if you want, and click Apply to push it
          live through PriceLabs.
        </p>
      </div>

      <div
        className={`rounded-lg px-4 py-2.5 text-sm ${
          autoApplyOn
            ? "bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-500/20"
            : "bg-black/[0.03] dark:bg-white/[0.05] text-black/50 dark:text-white/50"
        }`}
      >
        {autoApplyOn
          ? `🤖 Auto-apply band is ON — dates whose AI recommendation is within ${config.revenueAutoApplyBandPct}% of OwnerRez's live rate push automatically each day. Look for the "Auto" badge below.`
          : "Auto-apply band is OFF — every push above is the direct result of your own Apply click. Nothing here is ever pushed automatically unless you explicitly turn that on."}
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <RevenueManagementExplorer initialSnapshots={snapshots} initialOverrides={overrides} />
      </div>
    </div>
  );
}

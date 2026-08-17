import { isDbConfigured } from "@/lib/config";
import { listLeads } from "@/lib/leads";
import { getServerSession } from "@/lib/session";
import { cookies } from "next/headers";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { enforceBillingLock } from "@/lib/billingGate";
import { SalesPipelineExplorer } from "@/components/SalesPipelineExplorer";
import { PageHeader } from "@/components/PageHeader";
import { MARKETING_GROUP_TABS } from "@/lib/navGroups";

export const dynamic = "force-dynamic";

export default async function SalesPipelinePage() {
  if (!isDbConfigured()) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-sm text-black/50 dark:text-white/50">
          Database isn&rsquo;t connected yet, so the Sales Pipeline isn&rsquo;t available.
        </p>
      </div>
    );
  }

  const session = await getServerSession();
  await enforceBillingLock(session);
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const leads = await listLeads(session?.organizationId, groupId);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PageHeader
        eyebrow="Marketing"
        title="Pipeline"
        subtitle="Inquiries that haven't (yet) turned into a booking — new → contacted → qualified → proposal → deposit → booked, or lost/nurture."
        tabs={MARKETING_GROUP_TABS}
      />

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <SalesPipelineExplorer initialLeads={leads} />
      </div>
    </div>
  );
}

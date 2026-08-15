import { isDbConfigured } from "@/lib/config";
import { listLeads } from "@/lib/leads";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { SalesPipelineExplorer } from "@/components/SalesPipelineExplorer";
import { PageHeader } from "@/components/PageHeader";
import { CRM_GROUP_TABS } from "@/lib/navGroups";

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
  const leads = await listLeads(session?.organizationId);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PageHeader
        eyebrow="CRM"
        title="Pipeline"
        subtitle="Inquiries that haven't (yet) turned into a booking — new → contacted → qualified → proposal → deposit → booked, or lost/nurture."
        tabs={CRM_GROUP_TABS}
      />

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <SalesPipelineExplorer initialLeads={leads} />
      </div>
    </div>
  );
}

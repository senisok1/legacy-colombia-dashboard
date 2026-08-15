import { isDbConfigured } from "@/lib/config";
import { listVendors } from "@/lib/billPay";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { VendorsExplorer } from "@/components/VendorsExplorer";
import { PageHeader } from "@/components/PageHeader";
import { BILL_PAY_GROUP_TABS } from "@/lib/navGroups";

export const dynamic = "force-dynamic";

export default async function VendorsPage() {
  if (!isDbConfigured()) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-sm text-black/50 dark:text-white/50">
          Database isn&rsquo;t connected yet, so Vendors isn&rsquo;t available.
        </p>
      </div>
    );
  }

  const session = await getServerSession();
  await enforceBillingLock(session);
  const vendors = await listVendors(session?.organizationId);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PageHeader
        eyebrow="Bill Pay"
        title="Vendors"
        subtitle="Who you pay for maintenance, supplies, and services. Bills are tracked against these on the Bill Pay tab."
        tabs={BILL_PAY_GROUP_TABS}
      />

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <VendorsExplorer initialVendors={vendors} />
      </div>
    </div>
  );
}

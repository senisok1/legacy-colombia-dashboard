import { isDbConfigured } from "@/lib/config";
import { listWorkOrders } from "@/lib/maintenance";
import { listVendors } from "@/lib/billPay";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { MaintenanceExplorer } from "@/components/MaintenanceExplorer";

export const dynamic = "force-dynamic";

export default async function MaintenancePage() {
  if (!isDbConfigured()) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-sm text-black/50 dark:text-white/50">
          Database isn&rsquo;t connected yet, so Maintenance isn&rsquo;t available.
        </p>
      </div>
    );
  }

  const session = await getServerSession();
  await enforceBillingLock(session);
  const orgId = session?.organizationId;
  const [workOrders, vendors] = await Promise.all([listWorkOrders(orgId), listVendors(orgId)]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Maintenance</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Work-order tracking for reported issues — guest-flagged or logged by hand. Nothing here pages a vendor
          or messages a guest automatically.
        </p>
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <MaintenanceExplorer initialWorkOrders={workOrders} vendors={vendors} />
      </div>
    </div>
  );
}

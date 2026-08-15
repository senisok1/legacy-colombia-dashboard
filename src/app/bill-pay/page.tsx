import { isDbConfigured } from "@/lib/config";
import { listBills, listVendors } from "@/lib/billPay";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { BillPayExplorer } from "@/components/BillPayExplorer";
import { PageHeader } from "@/components/PageHeader";
import { BILL_PAY_GROUP_TABS } from "@/lib/navGroups";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function BillPayPage() {
  if (!isDbConfigured()) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <p className="text-sm text-black/50 dark:text-white/50">
          Database isn&rsquo;t connected yet, so Bill Pay isn&rsquo;t available.
        </p>
      </div>
    );
  }

  const session = await getServerSession();
  await enforceBillingLock(session);
  const orgId = session?.organizationId;
  const [bills, vendors] = await Promise.all([listBills(orgId), listVendors(orgId)]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PageHeader
        eyebrow="Bill Pay"
        title="Bill Pay"
        subtitle="Invoice tracking and duplicate/anomaly detection. No payments are ever sent from here."
        tabs={BILL_PAY_GROUP_TABS}
      />

      {vendors.length === 0 && (
        <div className="text-sm rounded-md bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-2">
          Add a vendor on the{" "}
          <Link href="/vendors" className="underline">
            Vendors
          </Link>{" "}
          tab before logging your first bill.
        </div>
      )}

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <BillPayExplorer initialBills={bills} vendors={vendors} />
      </div>
    </div>
  );
}

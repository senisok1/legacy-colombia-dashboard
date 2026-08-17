import { isDbConfigured } from "@/lib/config";
import { listBills, listVendors } from "@/lib/billPay";
import { getServerSession } from "@/lib/session";
import { cookies } from "next/headers";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, propertyGroupById } from "@/lib/propertyGroups";

import { enforceBillingLock } from "@/lib/billingGate";
import { BillPayExplorer } from "@/components/BillPayExplorer";
import { RecurringBills } from "@/components/RecurringBills";
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
  // Property scoping (2026-08-17, Seni: "ensure these tabs show only the
  // specific data for that specific property ONLY").
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const orgId = session?.organizationId;
  const [bills, vendors] = await Promise.all([listBills(orgId, groupId), listVendors(orgId, groupId)]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PageHeader
        eyebrow="Bill Pay"
        title={`Bill Pay — ${propertyGroupById(groupId).label}`}
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

      {/* Monthly recurring-bills checklist (2026-08-17, Seni's ask) — sits
          above the invoice explorer because it's the thing checked most
          often, and unpaid months roll forward into the current one. */}
      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <h2 className="text-sm font-semibold mb-3">Monthly recurring bills</h2>
        <RecurringBills />
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <BillPayExplorer initialBills={bills} vendors={vendors} />
      </div>
    </div>
  );
}

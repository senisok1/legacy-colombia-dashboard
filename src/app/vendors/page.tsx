import { isDbConfigured } from "@/lib/config";
import { listVendors } from "@/lib/billPay";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { cookies } from "next/headers";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
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
  // Property scoping (2026-08-17). listVendors() was called with the org id
  // only, so this tab listed every property's vendors while the sibling Bill
  // Pay tab (api/bills) was already scoped — the two disagreed. Same
  // resolution as dashboard/page.tsx: the cookie is only a request,
  // effectivePropertyGroupId() re-checks it against the viewer's
  // propertyAccess so a restricted login can't read another property.
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const vendors = await listVendors(session?.organizationId, groupId);

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

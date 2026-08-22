import { isDbConfigured } from "@/lib/config";
import { listWorkOrders } from "@/lib/maintenance";
import { listVendors } from "@/lib/billPay";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { cookies } from "next/headers";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
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
  // Property scoping (2026-08-17). This page used to call both lists with the
  // org id only, so Maintenance showed every property's work orders and
  // vendors regardless of which property was selected in the switcher — the
  // one place in the app that leaked other properties' data outright. Resolve
  // the group the same way dashboard/page.tsx does: the cookie is only a
  // request, effectivePropertyGroupId() re-checks it against the viewer's own
  // propertyAccess so a restricted login can't read a property it isn't on.
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const [workOrders, vendors] = await Promise.all([
    listWorkOrders(orgId, groupId),
    listVendors(orgId, groupId),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
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

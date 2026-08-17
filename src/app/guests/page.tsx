import { getBookings, getGuests } from "@/lib/ownerrez";
import { cookies } from "next/headers";
import { PROPERTY_GROUP_COOKIE, normalizePropertyGroupId } from "@/lib/propertyGroups";
import { buildGuestsWithStats } from "@/lib/guests";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { GuestsExplorer } from "@/components/GuestsExplorer";
import { PageHeader } from "@/components/PageHeader";
import { CRM_GROUP_TABS } from "@/lib/navGroups";

export const dynamic = "force-dynamic";

export default async function GuestsPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const orgId = session?.organizationId;
  const cookieStore = await cookies();
  const groupId = normalizePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value);
  const [guests, bookings] = await Promise.all([getGuests(orgId, groupId), getBookings(orgId, groupId)]);
  const guestsWithStats = await buildGuestsWithStats(guests, bookings, orgId);

  const repeatCount = guestsWithStats.filter((g) => g.isRepeat).length;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <PageHeader
        eyebrow="CRM"
        title="Guests"
        subtitle={`${guestsWithStats.length} guests on file · ${repeatCount} repeat guest${repeatCount === 1 ? "" : "s"}`}
        tabs={CRM_GROUP_TABS}
      />

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <GuestsExplorer guests={guestsWithStats} />
      </div>
    </div>
  );
}

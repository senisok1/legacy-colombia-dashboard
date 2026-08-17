import { parseISO } from "date-fns";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { buildGuestsById, resolveGuestName } from "@/lib/guestName";
import { UpcomingArrivals } from "@/components/UpcomingArrivals";
import { summaryStats, revenueBySource, isRevenueCounting } from "@/lib/finance";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { cookies } from "next/headers";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, propertyGroupById } from "@/lib/propertyGroups";
import { enforceBillingLock } from "@/lib/billingGate";
import { StatCard } from "@/components/StatCard";
import { Money } from "@/components/Money";
import { BookingsTable } from "@/components/BookingsTable";
import { OccupancyCalendar } from "@/components/OccupancyCalendar";
import { RevenueBySourceChart } from "@/components/RevenueBySourceChart";
import { listBookingExtras, EXTRAS_PROPERTY_GROUP_ID } from "@/lib/bookingExtras";
import { summarizeExtras, yearStartIso, EMPTY_EXTRAS_SUMMARY } from "@/lib/extrasAnalytics";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const [bookings, guests] = await Promise.all([
    getBookings(session?.organizationId, groupId),
    // Guest records — many channel bookings carry no name on the booking
    // itself; resolveGuestName fills it from the guest profile (2026-08-16,
    // Seni's ask: names were showing as "—" under Upcoming arrivals).
    getGuests(session?.organizationId, groupId).catch(() => []),
  ]);
  const guestsById = buildGuestsById(guests);
  // READ_ONLY team logins get an ops-focused dashboard: no revenue boxes,
  // no Total column, no MTD money stats (2026-08-16, Seni's ask). Admins
  // see everything.
  const isTeam = session?.role === "READ_ONLY";
  const withNames = (list: typeof bookings) =>
    list.map((b) => ({ ...b, raw: undefined, guestName: resolveGuestName(b, guestsById) || b.guestName }));
  const stats = summaryStats(bookings);

  // Every future arrival (not just the old top-5) — the UpcomingArrivals
  // client component pages through these with its Load-more button.
  const today = new Date().toISOString().slice(0, 10);
  const allUpcoming = withNames(
    bookings
      .filter((b) => b.status !== "Cancelled" && !b.isBlock && b.arrival && b.arrival.slice(0, 10) >= today)
      .sort((a, b) => a.arrival.localeCompare(b.arrival))
  );

  // Same year-to-date window as the "Revenue (YTD)" stat card above, so the
  // pie chart's total lines up with the number Seni already sees there.
  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const ytdBookings = bookings.filter(
    (b) => isRevenueCounting(b) && b.arrival && parseISO(b.arrival) >= yearStart
  );
  const revenueByChannel = revenueBySource(ytdBookings);

  // Paid extras, YTD (2026-08-17). Legacy Colombia only — no query at all on
  // the other properties, so their revenue card is untouched. Only the
  // HOUSE share is added to revenue: what the guest paid also contains
  // Gabriel's commission, which was never the house's money. See
  // lib/extrasAnalytics.ts.
  const extrasSummary =
    !isTeam && groupId === EXTRAS_PROPERTY_GROUP_ID
      ? summarizeExtras(bookings, await listBookingExtras(session!.organizationId).catch(() => new Map()), yearStartIso())
      : EMPTY_EXTRAS_SUMMARY;
  const showExtras = extrasSummary.count > 0;
  const totalRevenueYtd = stats.ytdRevenue + extrasSummary.houseRevenue;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Live snapshot of bookings, occupancy, and revenue for {propertyGroupById(groupId).label}.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {!isTeam && (
          <StatCard
            label={showExtras ? "Total revenue (YTD)" : "Revenue (YTD)"}
            value={<Money amount={showExtras ? totalRevenueYtd : stats.ytdRevenue} />}
            subLabel="Net"
            subValue={<Money amount={stats.ytdNetRevenue + extrasSummary.houseRevenue} />}
            hint={
              showExtras
                ? `Stays $${Math.round(stats.ytdRevenue).toLocaleString()} · Extras $${Math.round(
                    extrasSummary.houseRevenue
                  ).toLocaleString()} (house share) · ${stats.ytdBookings} bookings`
                : `${stats.ytdBookings} bookings · gross / net after channel fees`
            }
          />
        )}
        <StatCard label="Occupancy (90d)" value={`${stats.occupancyRate90d}%`} hint="Booked nights / available nights" />
        {!isTeam && (
          <StatCard
            label="Avg nightly rate"
            value={<Money amount={stats.avgNightlyRate} />}
            subLabel="Net"
            subValue={<Money amount={stats.avgNetNightlyRate} />}
            hint="Year to date · gross / net"
          />
        )}
        <StatCard label="Avg length of stay" value={`${stats.avgLengthOfStay} nights`} hint="Year to date" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <h2 className="text-sm font-semibold mb-3">Currently checked in ({stats.currentGuests.length})</h2>
          <BookingsTable bookings={withNames(stats.currentGuests)} emptyLabel="No guests on-property right now." showTotal={!isTeam} />

          <h2 className="text-sm font-semibold mt-6 mb-3">Upcoming arrivals</h2>
          <UpcomingArrivals bookings={allUpcoming} showTotal={!isTeam} />
        </div>

        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <OccupancyCalendar bookings={withNames(bookings)} showFinancials={!isTeam} />
        </div>
      </div>

      {!isTeam && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
            <h2 className="text-sm font-semibold mb-3">Revenue by channel (YTD) — gross &amp; net</h2>
            <RevenueBySourceChart breakdown={revenueByChannel} />
          </div>

          {showExtras && (
            <div className="lg:col-span-2 rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">Extras revenue (YTD) — house share</h2>
                {/* Labelled explicitly: unlike booking revenue, these figures
                    are typed in by hand on the Team Management tab and
                    reconcile to no payment processor. */}
                <span className="text-xs text-black/40 dark:text-white/40">Manually recorded</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-black/50 dark:text-white/50">
                    <th className="pb-1 font-medium">Extra</th>
                    <th className="pb-1 text-right font-medium">Times sold</th>
                    <th className="pb-1 text-right font-medium">Guest paid</th>
                    <th className="pb-1 text-right font-medium">House share</th>
                    <th className="pb-1 text-right font-medium">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {extrasSummary.byKind.map((row) => (
                    <tr key={row.label} className="border-t border-black/5 dark:border-white/5">
                      <td className="py-1">{row.label}</td>
                      <td className="py-1 text-right">{row.count}</td>
                      <td className="py-1 text-right text-black/50 dark:text-white/50">
                        <Money amount={row.guestPaid} />
                      </td>
                      <td className="py-1 text-right font-semibold">
                        <Money amount={row.houseRevenue} />
                      </td>
                      <td className="py-1 text-right text-black/50 dark:text-white/50">
                        <Money amount={row.commission} />
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-black/10 dark:border-white/10 font-semibold">
                    <td className="py-1">Total</td>
                    <td className="py-1 text-right">{extrasSummary.count}</td>
                    <td className="py-1 text-right">
                      <Money amount={extrasSummary.guestPaid} />
                    </td>
                    <td className="py-1 text-right">
                      <Money amount={extrasSummary.houseRevenue} />
                    </td>
                    <td className="py-1 text-right">
                      <Money amount={extrasSummary.commission} />
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-xs text-black/50 dark:text-white/50">
                Attach rate {extrasSummary.attachRatePct}% ({extrasSummary.staysWithExtras} of{" "}
                {extrasSummary.totalStays} stays) · ${Math.round(extrasSummary.houseRevenuePerStay).toLocaleString()} house
                share per stay. Only the house share counts as revenue — commission is Gabriel&apos;s and passes through.
              </p>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

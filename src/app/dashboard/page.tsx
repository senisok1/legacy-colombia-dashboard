import { parseISO } from "date-fns";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { buildGuestsById, resolveGuestName } from "@/lib/guestName";
import { UpcomingArrivals } from "@/components/UpcomingArrivals";
import { summaryStats, revenueBySource, isRevenueCounting } from "@/lib/finance";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { StatCard } from "@/components/StatCard";
import { Money } from "@/components/Money";
import { BookingsTable } from "@/components/BookingsTable";
import { OccupancyCalendar } from "@/components/OccupancyCalendar";
import { RevenueBySourceChart } from "@/components/RevenueBySourceChart";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const [bookings, guests] = await Promise.all([
    getBookings(session?.organizationId),
    // Guest records — many channel bookings carry no name on the booking
    // itself; resolveGuestName fills it from the guest profile (2026-08-16,
    // Seni's ask: names were showing as "—" under Upcoming arrivals).
    getGuests(session?.organizationId).catch(() => []),
  ]);
  const guestsById = buildGuestsById(guests);
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

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Live snapshot of bookings, occupancy, and revenue for Legacy Colombia.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Revenue (YTD)"
          value={<Money amount={stats.ytdRevenue} />}
          subLabel="Net"
          subValue={<Money amount={stats.ytdNetRevenue} />}
          hint={`${stats.ytdBookings} bookings · gross / net after channel fees`}
        />
        <StatCard label="Occupancy (90d)" value={`${stats.occupancyRate90d}%`} hint="Booked nights / available nights" />
        <StatCard
          label="Avg nightly rate"
          value={<Money amount={stats.avgNightlyRate} />}
          subLabel="Net"
          subValue={<Money amount={stats.avgNetNightlyRate} />}
          hint="Year to date · gross / net"
        />
        <StatCard label="Avg length of stay" value={`${stats.avgLengthOfStay} nights`} hint="Year to date" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <h2 className="text-sm font-semibold mb-3">Currently checked in ({stats.currentGuests.length})</h2>
          <BookingsTable bookings={withNames(stats.currentGuests)} emptyLabel="No guests on-property right now." />

          <h2 className="text-sm font-semibold mt-6 mb-3">Upcoming arrivals</h2>
          <UpcomingArrivals bookings={allUpcoming} />
        </div>

        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <OccupancyCalendar bookings={bookings} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <h2 className="text-sm font-semibold mb-3">Revenue by channel (YTD) — gross &amp; net</h2>
          <RevenueBySourceChart breakdown={revenueByChannel} />
        </div>
      </div>

    </div>
  );
}

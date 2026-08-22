import { parseISO } from "date-fns";
import { getBookings, getGuests } from "@/lib/ownerrez";
import { buildGuestsById, resolveGuestName, selfHealGuestsById } from "@/lib/guestName";
import { UpcomingArrivals } from "@/components/UpcomingArrivals";
import { summaryStats, revenueBySource, isRevenueCounting } from "@/lib/finance";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { cookies } from "next/headers";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId } from "@/lib/propertyGroups";
import { enforceBillingLock } from "@/lib/billingGate";
import { StatCard } from "@/components/StatCard";
import { Money } from "@/components/Money";
import { PropertyHero } from "@/components/shell/PropertyHero";
import { BookingsTable } from "@/components/BookingsTable";
import { OccupancyCalendar } from "@/components/OccupancyCalendar";
import { RevenueBySourceChart } from "@/components/RevenueBySourceChart";
import { listBookingExtras, EXTRAS_PROPERTY_GROUP_ID } from "@/lib/bookingExtras";
import { summarizeExtras, yearStartIso, EMPTY_EXTRAS_SUMMARY } from "@/lib/extrasAnalytics";
import { getUsdToRate } from "@/lib/exchangeRate";
import { ssrSnapshotFirst } from "@/lib/ssrSnapshot";
import { AutoRefresh } from "@/components/AutoRefresh";
import type { Booking, Guest } from "@/lib/types";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const DASHBOARD_SNAPSHOT_TTL_SECONDS = 6 * 60 * 60;

export default async function DashboardPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  // INSTANT LOAD (2026-08-19, Seni's "everything instant" pass): the page
  // used to block its whole HTML response on live getBookings+getGuests —
  // now the last known-good pair is served from a Redis snapshot instantly,
  // rebuilt in the background, and <AutoRefresh /> below swaps the fresh
  // copy in moments later. `raw` payloads are stripped before storing (the
  // dashboard never reads them, and they'd multiply the snapshot's size).
  const { data, fromSnapshot } = await ssrSnapshotFirst<{ bookings: Booking[]; guests: Guest[] }>(
    `dashboard:data:${session?.organizationId ?? "default"}:${groupId}`,
    DASHBOARD_SNAPSHOT_TTL_SECONDS,
    async () => {
      const [bookings, guests] = await Promise.all([
        getBookings(session?.organizationId, groupId),
        // Guest records — many channel bookings carry no name on the booking
        // itself; resolveGuestName fills it from the guest profile (2026-08-16,
        // Seni's ask: names were showing as "—" under Upcoming arrivals).
        getGuests(session?.organizationId, groupId).catch(() => []),
      ]);
      // Self-heal (2026-08-21, Seni: "the new booking that just came in is
      // just showing 'guest' and not name. Please fix once and for all!") —
      // a brand-new booking's guest record can still be unresolvable within
      // getGuests()'s own 60s cache cycle; do one bounded direct lookup for
      // just the bookings still missing a name before this snapshot gets
      // written, so the fix lands as soon as this snapshot rebuilds instead
      // of waiting on a wider guest-list cache cycle too.
      const healedGuestsById = await selfHealGuestsById(bookings, buildGuestsById(guests), session?.organizationId);
      const guestIds = new Set(guests.map((g) => g.id));
      const healedGuests = [...guests, ...[...healedGuestsById.values()].filter((g) => !guestIds.has(g.id))];
      return {
        bookings: bookings.map((b) => ({ ...b, raw: undefined })),
        guests: healedGuests.map((g) => ({ ...g, raw: undefined })),
      };
    }
  );
  const { bookings, guests } = data;
  const guestsById = buildGuestsById(guests);
  // READ_ONLY team logins get an ops-focused dashboard: no revenue boxes,
  // no Total column, no MTD money stats (2026-08-16, Seni's ask). Admins
  // see everything. CONSTRUCTION logins get the SAME ops-focused view
  // (2026-08-20, Seni's ask: "give the construction management team members
  // the same dashboard tab view that the team members have") — construction
  // team members shouldn't see property revenue any more than a cleaner
  // would.
  const isTeam = session?.role === "READ_ONLY" || session?.role === "CONSTRUCTION";
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
  // Must use the SAME bounded window as summaryStats' ytdRevenue — including
  // the `<= now` upper bound added in the 2026-08-17 audit. Bounding only the
  // stat card would leave this chart counting the entire forward book, so the
  // pie's total would visibly exceed the Revenue (YTD) figure right above it,
  // which is precisely what this comment originally existed to prevent.
  const nowForYtd = new Date();
  const yearStart = new Date(nowForYtd.getFullYear(), 0, 1);
  const ytdBookings = bookings.filter(
    (b) =>
      isRevenueCounting(b) &&
      b.arrival &&
      parseISO(b.arrival) >= yearStart &&
      parseISO(b.arrival) <= nowForYtd
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
  // extrasSummary's guestPaid/houseRevenue/commission are COP-native (Gabriel
  // always enters local-vendor cash in pesos — see lib/bookingExtras.ts and
  // lib/extrasAnalytics.ts), while stats.ytdRevenue is genuinely USD
  // (OwnerRez's own booking totals). Blending them with a raw `+` (as this
  // used to do) added a peso figure onto a dollar figure — e.g. a 130,000
  // COP house share silently became "$130,000" of extra YTD revenue.
  // Discovered 2026-08-22 alongside the same bug in the Commissions tab's
  // headline totals (Seni: Gabriel's pontoon entry). Converts to a genuine
  // USD-equivalent before folding into the USD-native total; only fetches a
  // rate when there's actually an extras figure to convert.
  const extrasFxRate = showExtras ? await getUsdToRate("COP").catch(() => null) : null;
  const extrasHouseRevenueUsd = extrasFxRate ? extrasSummary.houseRevenue / extrasFxRate.usdToTarget : 0;
  const totalRevenueYtd = stats.ytdRevenue + extrasHouseRevenueUsd;
  const lang = viewer?.language;

  return (
    <div className="mx-auto max-w-6xl px-4 md:px-6 py-4 md:py-6 space-y-5 md:space-y-6">
      <AutoRefresh enabled={fromSnapshot} />
      {/* The page's own "Dashboard" heading moved into the shell's top
          header (2026-08-22 UI refresh) — repeating it here would say the
          same thing twice. Its place is taken by the property hero, which
          uses this property's own top OwnerRez photo. */}
      <PropertyHero groupId={groupId} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {!isTeam && (
          <StatCard
            label={showExtras ? "Total revenue (YTD)" : "Revenue (YTD)"}
            value={<Money amount={showExtras ? totalRevenueYtd : stats.ytdRevenue} />}
            subLabel="Net"
            subValue={<Money amount={stats.ytdNetRevenue + extrasHouseRevenueUsd} />}
            hint={
              showExtras ? (
                // 2026-08-22 fix (Seni: "it shows stays in USD and Extras in
                // COP and it doesn't change when toggled") — this used to be
                // a hardcoded string with a literal "$" and " COP" baked in,
                // so it never reacted to the currency toggle at all. Stays
                // is USD-native, extras house share is COP-native (see
                // extrasHouseRevenueUsd above and lib/bookingExtras.ts) —
                // <Money> leaves with the correct native currency each
                // convert through useCurrency() same as the headline
                // value/subValue above, so both figures now follow the
                // toggle together.
                <>
                  Stays <Money amount={stats.ytdRevenue} /> · Extras{" "}
                  <Money amount={extrasSummary.houseRevenue} currency="COP" /> (house share) ·{" "}
                  {stats.ytdBookings} bookings
                </>
              ) : (
                `${stats.ytdBookings} bookings · gross / net after channel fees`
              )
            }
          />
        )}
        <StatCard label={t("dash.occupancy90d", lang)} value={`${stats.occupancyRate90d}%`} hint={t("dash.occupancyHint", lang)} />
        {!isTeam && (
          <StatCard
            label="Avg nightly rate"
            value={<Money amount={stats.avgNightlyRate} />}
            subLabel="Net"
            subValue={<Money amount={stats.avgNetNightlyRate} />}
            hint="Year to date · gross / net"
          />
        )}
        <StatCard label={t("dash.avgLengthOfStay", lang)} value={`${stats.avgLengthOfStay} ${t("mgmt.nights", lang)}`} hint={t("dash.yearToDate", lang)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <h2 className="text-sm font-semibold mb-3">
            {t("dash.currentlyCheckedIn", lang)} ({stats.currentGuests.length})
          </h2>
          <BookingsTable
            bookings={withNames(stats.currentGuests)}
            emptyLabel={t("dash.noGuestsOnProperty", lang)}
            showTotal={!isTeam}
          />

          <h2 className="text-sm font-semibold mt-6 mb-3">{t("dash.upcomingArrivals", lang)}</h2>
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
                  {/* Extras figures are COP-native throughout (2026-08-22
                      fix) — explicit currency="COP" so <Money> formats/
                      converts them correctly instead of assuming its USD
                      default. */}
                  {extrasSummary.byKind.map((row) => (
                    <tr key={row.label} className="border-t border-black/5 dark:border-white/5">
                      <td className="py-1">{row.label}</td>
                      <td className="py-1 text-right">{row.count}</td>
                      <td className="py-1 text-right text-black/50 dark:text-white/50">
                        <Money amount={row.guestPaid} currency="COP" />
                      </td>
                      <td className="py-1 text-right font-semibold">
                        <Money amount={row.houseRevenue} currency="COP" />
                      </td>
                      <td className="py-1 text-right text-black/50 dark:text-white/50">
                        <Money amount={row.commission} currency="COP" />
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-black/10 dark:border-white/10 font-semibold">
                    <td className="py-1">Total</td>
                    <td className="py-1 text-right">{extrasSummary.count}</td>
                    <td className="py-1 text-right">
                      <Money amount={extrasSummary.guestPaid} currency="COP" />
                    </td>
                    <td className="py-1 text-right">
                      <Money amount={extrasSummary.houseRevenue} currency="COP" />
                    </td>
                    <td className="py-1 text-right">
                      <Money amount={extrasSummary.commission} currency="COP" />
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-xs text-black/50 dark:text-white/50">
                Attach rate {extrasSummary.attachRatePct}% ({extrasSummary.staysWithExtras} of{" "}
                {extrasSummary.totalStays} stays) · {Math.round(extrasSummary.houseRevenuePerStay).toLocaleString()} COP house
                share per stay. Only the house share counts as revenue — commission is Gabriel&apos;s and passes through.
              </p>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

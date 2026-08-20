import { getBookings } from "@/lib/ownerrez";
import { occupancyRate, revenueByMonth, revenueBySource } from "@/lib/finance";
import { buildExecutiveReport } from "@/lib/executiveReport";
import { buildTrendReport } from "@/lib/trendReport";
import { getServerSession } from "@/lib/session";
import { cookies } from "next/headers";
import { getUserByEmail } from "@/lib/users";
import { PROPERTY_GROUP_COOKIE, effectivePropertyGroupId, propertyGroupById } from "@/lib/propertyGroups";
import { enforceBillingLock } from "@/lib/billingGate";
import { StatCard } from "@/components/StatCard";
import { ExecutiveSummary } from "@/components/ExecutiveSummary";
import { TrendSummary } from "@/components/TrendSummary";
import { RevenueChart } from "@/components/charts/RevenueChart";
import { SourceChart } from "@/components/charts/SourceChart";
import { ssrSnapshotFirst } from "@/lib/ssrSnapshot";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

const REPORTS_SNAPSHOT_TTL_SECONDS = 6 * 60 * 60;

export default async function ReportsPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  // Property scoping (2026-08-17) — Reports used to compute from Legacy
  // Colombia's bookings no matter which property was selected.
  const cookieStore = await cookies();
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const groupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, viewer?.propertyAccess);
  const orgId = session?.organizationId;
  // INSTANT LOAD (2026-08-19, Seni's "everything instant" pass): same
  // snapshot-first pattern as the Dashboard — the derived report figures are
  // served from Redis instantly, rebuilt in the background, and AutoRefresh
  // swaps the fresh copy in moments later. The already-derived numbers are
  // snapshotted (not the raw bookings), so this stores kilobytes, not the
  // whole booking list.
  const { data, fromSnapshot } = await ssrSnapshotFirst(
    `reports:data:${orgId ?? "default"}:${groupId}`,
    REPORTS_SNAPSHOT_TTL_SECONDS,
    async () => {
      const [bookings, report, trendReport] = await Promise.all([
        getBookings(orgId, groupId),
        buildExecutiveReport(orgId, groupId),
        buildTrendReport(orgId, groupId),
      ]);
      return {
        report,
        trendReport,
        monthly: revenueByMonth(bookings, 12),
        bySource: revenueBySource(bookings),
        occ365: occupancyRate(bookings, 365),
      };
    }
  );
  const { report, trendReport, monthly, bySource, occ365 } = data;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <AutoRefresh enabled={fromSnapshot} />
      <div>
        <h1 className="text-xl font-semibold">Reports — {propertyGroupById(groupId).label}</h1>
        <p className="text-sm text-black/50 dark:text-white/50">
          Revenue and occupancy, computed directly from your booking data.
        </p>
      </div>

      <ExecutiveSummary report={report} />

      <TrendSummary report={trendReport} />

      {/* Revenue YTD, Occupancy (30d), and Cancellation rate are already shown
          above in ExecutiveSummary — Occupancy (12mo) is the one number here
          that isn't, so that's all that's left in this smaller strip. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Occupancy (12mo)" value={`${occ365}%`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <h2 className="text-sm font-semibold mb-3">Monthly revenue (last 12 months)</h2>
          <RevenueChart data={monthly} />
        </div>
        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <h2 className="text-sm font-semibold mb-3">Revenue by channel</h2>
          <SourceChart data={bySource} />
        </div>
      </div>
    </div>
  );
}

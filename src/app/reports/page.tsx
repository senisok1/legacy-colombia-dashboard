import { getBookings } from "@/lib/ownerrez";
import { occupancyRate, revenueByMonth, revenueBySource } from "@/lib/finance";
import { buildExecutiveReport } from "@/lib/executiveReport";
import { buildTrendReport } from "@/lib/trendReport";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { StatCard } from "@/components/StatCard";
import { ExecutiveSummary } from "@/components/ExecutiveSummary";
import { TrendSummary } from "@/components/TrendSummary";
import { RevenueChart } from "@/components/charts/RevenueChart";
import { SourceChart } from "@/components/charts/SourceChart";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const orgId = session?.organizationId;
  const [bookings, report, trendReport] = await Promise.all([
    getBookings(orgId),
    buildExecutiveReport(orgId),
    buildTrendReport(orgId),
  ]);
  const monthly = revenueByMonth(bookings, 12);
  const bySource = revenueBySource(bookings);
  const occ365 = occupancyRate(bookings, 365);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
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

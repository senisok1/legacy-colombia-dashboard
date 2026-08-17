import Link from "next/link";
import type { ExecutiveReport } from "@/lib/executiveReport";
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import { StatCard } from "@/components/StatCard";
import { Money } from "@/components/Money";

// Phase 8 — the Data Analyst agent's "30-second read" (docs/VISION.md),
// rendered on-demand here and pushed to WhatsApp each morning by
// api/cron/daily-report. Every number comes straight from
// lib/executiveReport.ts; this component just lays it out and makes the
// data gaps impossible to miss, rather than letting them quietly read as
// zeros.

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  info: "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60",
};

export function ExecutiveSummary({ report }: { report: ExecutiveReport }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold">Daily executive summary</h2>
          <p className="text-xs text-black/40 dark:text-white/40">
            Generated {formatRelativeTime(report.generatedAt)} · same report sent to WhatsApp each morning
          </p>
        </div>
      </div>

      {report.urgentApprovals.total > 0 && (
        <div className="rounded-xl border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm font-medium text-red-800 dark:text-red-300">
          🔴 {report.urgentApprovals.total} urgent approval{report.urgentApprovals.total === 1 ? "" : "s"} need your decision today
          {" — "}
          {[
            report.urgentApprovals.staleGuestReplies > 0
              ? `${report.urgentApprovals.staleGuestReplies} guest repl${report.urgentApprovals.staleGuestReplies === 1 ? "y" : "ies"} waiting`
              : null,
            report.urgentApprovals.billsDueUrgent > 0 ? `${report.urgentApprovals.billsDueUrgent} bill(s) due within 48h` : null,
            report.urgentApprovals.urgentMaintenance > 0
              ? `${report.urgentApprovals.urgentMaintenance} urgent maintenance issue(s)`
              : null,
          ]
            .filter(Boolean)
            .join(", ")}
        </div>
      )}

      {report.cooBriefing && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-500/10 px-4 py-3">
          <div className="text-xs font-semibold text-blue-800 dark:text-blue-300 mb-1">🧭 AI COO</div>
          <p className="text-sm text-blue-950 dark:text-blue-100">{report.cooBriefing.narrative}</p>
          {report.cooBriefing.priorities.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-blue-950 dark:text-blue-100 list-disc pl-4">
              {report.cooBriefing.priorities.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Occupancy (30d)" value={`${report.occupancy30d}%`} />
        <StatCard
          label="ADR (30d)"
          value={<Money amount={report.adrGross} />}
          subLabel="Net"
          subValue={<Money amount={report.adrNet} />}
        />
        <StatCard
          label="RevPAR (30d)"
          value={<Money amount={report.revParGross} />}
          subLabel="Net"
          subValue={<Money amount={report.revParNet} />}
        />
        <StatCard label="Direct bookings (30d)" value={`${report.directBookingPct}%`} />
        <StatCard
          label={report.extrasYtd?.count ? "Total revenue YTD" : "Revenue YTD"}
          value={<Money amount={report.extrasYtd?.count ? report.totalRevenueYtdGross : report.revenueYtdGross} />}
          subLabel="Net"
          subValue={<Money amount={report.revenueYtdNet + (report.extrasYtd?.houseRevenue ?? 0)} />}
          hint={
            report.extrasYtd?.count
              ? `Stays $${Math.round(report.revenueYtdGross).toLocaleString()} · Extras $${Math.round(
                  report.extrasYtd.houseRevenue
                ).toLocaleString()} (house share)`
              : undefined
          }
        />
        <StatCard
          label={report.extrasMtd?.count ? "Total revenue MTD" : "Revenue MTD"}
          value={<Money amount={report.extrasMtd?.count ? report.totalRevenueMtdGross : report.revenueMtdGross} />}
          hint={
            report.extrasMtd?.count
              ? `Stays $${Math.round(report.revenueMtdGross).toLocaleString()} · Extras $${Math.round(
                  report.extrasMtd.houseRevenue
                ).toLocaleString()}`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard label="Revenue today" value={<Money amount={report.revenueTodayGross} />} hint="New bookings made today" />
        <StatCard label="On the books (30d)" value={`${report.bookingPace.d30.pct}%`} />
        <StatCard label="On the books (90d)" value={`${report.bookingPace.d90.pct}%`} />
        <StatCard label="On the books (12mo)" value={`${report.bookingPace.d365.pct}%`} />
        <StatCard
          label={`Inquiries (${report.inquiries.windowDays}d)`}
          value={String(report.inquiries.count)}
          subLabel="Converted"
          subValue={`${report.inquiries.conversionPct}%`}
        />
        <StatCard
          label="Guest response time"
          value={report.guestResponseTime.sampleSize > 0 ? `${report.guestResponseTime.avgMinutes}m` : "—"}
          hint={
            report.guestResponseTime.sampleSize > 0
              ? `Avg over ${report.guestResponseTime.sampleSize} repl${report.guestResponseTime.sampleSize === 1 ? "y" : "ies"}, ${report.guestResponseTime.windowDays}d`
              : "Still collecting data"
          }
        />
        <StatCard
          label="Weekday / weekend rate"
          value={report.weekdayWeekendRate.weekdayAvgGross !== null ? <Money amount={report.weekdayWeekendRate.weekdayAvgGross} /> : "—"}
          subLabel="Weekend"
          subValue={report.weekdayWeekendRate.weekendAvgGross !== null ? <Money amount={report.weekdayWeekendRate.weekendAvgGross} /> : "—"}
          hint="Live OwnerRez quotes, next 2 weeks"
        />
        <StatCard
          label="Last-minute discount"
          value={
            report.lastMinuteDiscount.reliable && report.lastMinuteDiscount.discountPct !== null
              ? `${Math.abs(report.lastMinuteDiscount.discountPct)}%`
              : "—"
          }
          hint={
            report.lastMinuteDiscount.reliable && report.lastMinuteDiscount.discountPct !== null
              ? report.lastMinuteDiscount.discountPct > 0
                ? "Less per night than 21+ day planners"
                : "More per night than 21+ day planners"
              : `Not enough bookings yet (${report.lastMinuteDiscount.lastMinuteSampleSize} last-minute, ${report.lastMinuteDiscount.advanceSampleSize} advance)`
          }
        />
        <StatCard
          label="Reviews"
          value={report.reputation.avgRating !== null ? `${report.reputation.avgRating.toFixed(2)}★` : "—"}
          subLabel="Unanswered"
          subValue={String(report.reputation.needsResponseCount)}
          hint={`${report.reputation.totalReviews} total on OwnerRez`}
        />
        <StatCard
          label="AI vs. PriceLabs rate"
          value={report.rateComparison.aiAvgGross !== null ? <Money amount={report.rateComparison.aiAvgGross} /> : "—"}
          subLabel="PriceLabs"
          subValue={report.rateComparison.priceLabsAvgGross !== null ? <Money amount={report.rateComparison.priceLabsAvgGross} /> : "—"}
          // Note: this hint is a plain string prop (not JSX), so it can't embed
          // the <Money> client leaf — it always shows the live OwnerRez figure
          // in native USD regardless of the currency toggle. Lower-priority
          // inconsistency, left as-is rather than restructuring StatCard's hint
          // prop just for this one tooltip.
          hint={
            report.rateComparison.datesTracked > 0
              ? `Live OwnerRez: ${report.rateComparison.ownerRezAvgGross !== null ? formatCurrency(report.rateComparison.ownerRezAvgGross) + ` (n=${report.rateComparison.ownerRezSampleSize})` : "n/a"} · ${report.rateComparison.avgAiVsPriceLabsPct !== null ? `AI ${report.rateComparison.avgAiVsPriceLabsPct > 0 ? "+" : ""}${report.rateComparison.avgAiVsPriceLabsPct}% vs PriceLabs` : ""} · avg over ${report.rateComparison.datesTracked} dates`
              : "No rate snapshots yet"
          }
        />
        <StatCard
          label="Cancellation rate"
          value={report.cancellation.totalCount > 0 ? `${report.cancellation.pct}%` : "—"}
          hint={report.cancellation.totalCount > 0 ? `${report.cancellation.cancelledCount} of ${report.cancellation.totalCount} bookings` : "No bookings yet"}
        />
        <StatCard
          label="Avg length of stay"
          value={`${report.avgLengthOfStayNights} night${report.avgLengthOfStayNights === 1 ? "" : "s"}`}
          hint="Year to date"
        />
        <StatCard
          label="Repeat-guest rate"
          value={report.repeatGuest.totalGuests > 0 ? `${report.repeatGuest.pct}%` : "—"}
          hint={
            report.repeatGuest.totalGuests > 0
              ? `${report.repeatGuest.repeatGuests} of ${report.repeatGuest.totalGuests} guests have stayed more than once`
              : "No guest history yet"
          }
        />
      </div>

      {(report.extrasYtd?.count ?? 0) > 0 && (
        <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Extras &amp; ancillary revenue (YTD)</h3>
            {/* Unlike booking revenue this is hand-entered and reconciles to
                no payment processor — say so rather than let it read as
                platform-sourced. */}
            <span className="text-xs text-black/40 dark:text-white/40">Manually recorded</span>
          </div>
          <p className="mb-3 text-xs text-black/50 dark:text-white/50">
            Only the house share counts as revenue — the guest total also contains Gabriel&apos;s commission, which
            passes through. Extras are deliberately excluded from ADR, RevPAR and occupancy above.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-black/50 dark:text-white/50">
                <th className="pb-1 font-medium">Extra</th>
                <th className="pb-1 text-right font-medium">Sold</th>
                <th className="pb-1 text-right font-medium">Guest paid</th>
                <th className="pb-1 text-right font-medium">House share</th>
                <th className="pb-1 text-right font-medium">Commission</th>
              </tr>
            </thead>
            <tbody>
              {report.extrasYtd.byKind.map((row) => (
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
                <td className="py-1 text-right">{report.extrasYtd.count}</td>
                <td className="py-1 text-right">
                  <Money amount={report.extrasYtd.guestPaid} />
                </td>
                <td className="py-1 text-right">
                  <Money amount={report.extrasYtd.houseRevenue} />
                </td>
                <td className="py-1 text-right">
                  <Money amount={report.extrasYtd.commission} />
                </td>
              </tr>
            </tbody>
          </table>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Attach rate"
              value={`${report.extrasYtd.attachRatePct}%`}
              hint={`${report.extrasYtd.staysWithExtras} of ${report.extrasYtd.totalStays} stays bought at least one extra`}
            />
            <StatCard
              label="House share per stay"
              value={<Money amount={report.extrasYtd.houseRevenuePerStay} />}
              hint="Averaged across every stay, not just those with extras"
            />
            <StatCard label="Extras MTD (house)" value={<Money amount={report.extrasMtd.houseRevenue} />} />
            <StatCard
              label="Commission paid YTD"
              value={<Money amount={report.extrasYtd.commission} />}
              hint="A cost, not revenue"
            />
          </div>
        </div>
      )}

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <h3 className="text-sm font-medium mb-2">Needs your attention</h3>
        {report.topAttention.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">Nothing needs your attention right now.</p>
        ) : (
          <div className="space-y-2">
            {report.topAttention.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="flex items-center justify-between gap-2 text-sm rounded-md px-2 py-1.5 -mx-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
              >
                <span>{item.label}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${SEVERITY_STYLES[item.severity]}`}>
                  {item.severity}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <details className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-black/[0.02] dark:bg-white/[0.03]">
        <summary className="text-xs font-medium cursor-pointer text-black/60 dark:text-white/60">
          What this report can&rsquo;t tell you yet ({report.dataGaps.length})
        </summary>
        <ul className="mt-2 space-y-1.5 text-xs text-black/50 dark:text-white/50 list-disc pl-4">
          {report.dataGaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

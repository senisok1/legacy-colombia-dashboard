import type { MetricComparison, PeriodComparison, TrendReport } from "@/lib/trendReport";
import { formatRelativeTime } from "@/lib/format";

// Weekly trend report (see lib/trendReport.ts) — same numbers pushed to
// WhatsApp/email every Monday, rendered here for on-demand viewing. Rolling
// trailing windows (7d/30d), not calendar week/month — see that file's
// header comment for why.

function deltaColor(m: MetricComparison): string {
  const v = m.deltaPts !== undefined ? m.deltaPts : m.deltaPct;
  if (v === null || v === undefined || v === 0) return "text-black/50 dark:text-white/50";
  return v > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
}

function deltaLabel(m: MetricComparison): string {
  if (m.deltaPts !== undefined) {
    return m.deltaPts === 0 ? "flat" : `${m.deltaPts > 0 ? "+" : ""}${m.deltaPts}pt`;
  }
  if (m.deltaPct === null) return "n/a";
  return m.deltaPct === 0 ? "flat" : `${m.deltaPct > 0 ? "+" : ""}${m.deltaPct}%`;
}

function Row({
  label,
  m,
  format,
}: {
  label: string;
  m: MetricComparison;
  format: (n: number) => string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-black/5 dark:border-white/10 last:border-0 text-sm">
      <span className="text-black/60 dark:text-white/60">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-medium">{format(m.current)}</span>
        <span className="text-xs text-black/30 dark:text-white/30">was {format(m.prior)}</span>
        <span className={`text-xs font-medium ${deltaColor(m)}`}>{deltaLabel(m)}</span>
      </span>
    </div>
  );
}

function Section({ c }: { c: PeriodComparison }) {
  const money = (n: number) => `$${n.toFixed(0)}`;
  const pct = (n: number) => `${n}%`;
  const count = (n: number) => `${n}`;
  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
      <h3 className="text-sm font-semibold mb-2">{c.label}</h3>
      <Row label="Occupancy" m={c.occupancyPct} format={pct} />
      <Row label="ADR (gross)" m={c.adrGross} format={money} />
      <Row label="RevPAR (gross)" m={c.revParGross} format={money} />
      <Row label="Revenue (gross)" m={c.revenueGross} format={money} />
      <Row label="New bookings made" m={c.newBookingsCount} format={count} />
      <Row label="Pickup revenue" m={c.pickupRevenueGross} format={money} />
    </div>
  );
}

export function TrendSummary({ report }: { report: TrendReport }) {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Weekly trend report</h2>
        <p className="text-xs text-black/40 dark:text-white/40">
          Generated {formatRelativeTime(report.generatedAt)} · same report sent every Monday over WhatsApp/email
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section c={report.weekly} />
        <Section c={report.monthly} />
      </div>
    </div>
  );
}

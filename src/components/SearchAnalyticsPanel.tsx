"use client";

import type { SearchConsolePerformance, Ga4Overview } from "@/lib/searchAnalytics";

// Real Search Console + GA4 numbers (task #172) — not AI-drafted, not
// estimated. Pulled server-side via a Google service account scoped only to
// the legacycolombia.com / Legacy Colombia properties (see
// lib/searchAnalytics.ts's header comment). If GA4 shows all zeros, that's
// because tracking isn't installed on the site yet (task #175 — deferred at
// Seni's request), not because traffic is actually zero.

type GscResult = SearchConsolePerformance | { error: string } | null;
type Ga4Result = Ga4Overview | { error: string } | null;

function isError(x: unknown): x is { error: string } {
  return Boolean(x && typeof x === "object" && "error" in x);
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatPos(n: number): string {
  return n.toFixed(1);
}

export function SearchAnalyticsPanel({ gsc, ga4 }: { gsc: GscResult; ga4: Ga4Result }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Search &amp; site performance</h2>
        <p className="text-xs text-black/40 dark:text-white/40">
          Live data from Google Search Console{ga4 ? " and GA4" : ""} — scoped only to legacycolombia.com.
        </p>
      </div>

      {gsc === null && ga4 === null && (
        <p className="text-sm text-black/50 dark:text-white/50">
          Search Console / GA4 access isn&rsquo;t configured yet.
        </p>
      )}

      {isError(gsc) && (
        <p className="text-xs text-red-600 dark:text-red-400">Search Console error: {gsc.error}</p>
      )}
      {gsc && !isError(gsc) && (
        <div className="space-y-3">
          <p className="text-xs text-black/40 dark:text-white/40">
            Search Console, {gsc.startDate} to {gsc.endDate}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Clicks" value={gsc.totals.clicks.toLocaleString()} />
            <Stat label="Impressions" value={gsc.totals.impressions.toLocaleString()} />
            <Stat label="Avg CTR" value={formatPct(gsc.totals.ctr)} />
            <Stat label="Avg position" value={formatPos(gsc.totals.position)} />
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <RowTable title="Top queries" rows={gsc.topQueries} />
            <RowTable title="Top pages" rows={gsc.topPages} truncatePath />
          </div>
        </div>
      )}

      {isError(ga4) && <p className="text-xs text-red-600 dark:text-red-400">GA4 error: {ga4.error}</p>}
      {ga4 && !isError(ga4) && (
        <div className="space-y-2 pt-1 border-t border-black/5 dark:border-white/10">
          <p className="text-xs text-black/40 dark:text-white/40 pt-3">
            GA4, {ga4.startDate} to {ga4.endDate}
          </p>
          {ga4.noData ? (
            <p className="text-sm text-black/50 dark:text-white/50">
              GA4 shows no tracked sessions yet — the tracking snippet isn&rsquo;t installed on the site (Site Kit
              install is queued, not done). Not an estimate — this is a real gap, not zero traffic.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Sessions" value={ga4.sessions.toLocaleString()} />
              <Stat label="Active users" value={ga4.activeUsers.toLocaleString()} />
              <Stat label="Page views" value={ga4.pageViews.toLocaleString()} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 px-3 py-2">
      <p className="text-[11px] text-black/40 dark:text-white/40">{label}</p>
      <p className="text-base font-semibold">{value}</p>
    </div>
  );
}

function RowTable({
  title,
  rows,
  truncatePath,
}: {
  title: string;
  rows: { key: string; clicks: number; impressions: number; ctr: number; position: number }[];
  truncatePath?: boolean;
}) {
  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 overflow-hidden">
      <p className="text-xs font-medium px-3 py-2 bg-black/[0.03] dark:bg-white/[0.05]">{title}</p>
      <table className="w-full text-xs">
        <thead className="text-black/40 dark:text-white/40">
          <tr>
            <th className="text-left px-3 py-1.5 font-medium">{title === "Top pages" ? "Page" : "Query"}</th>
            <th className="text-right px-3 py-1.5 font-medium">Clicks</th>
            <th className="text-right px-3 py-1.5 font-medium">Impr.</th>
            <th className="text-right px-3 py-1.5 font-medium">Pos.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-black/5 dark:border-white/5">
              <td className="px-3 py-1.5 max-w-[220px] truncate" title={r.key}>
                {truncatePath ? r.key.replace(/^https?:\/\/[^/]+/, "") || "/" : r.key}
              </td>
              <td className="px-3 py-1.5 text-right">{r.clicks.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-right">{r.impressions.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-right">{formatPos(r.position)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="text-center py-4 text-black/40 dark:text-white/40">
                No data for this window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

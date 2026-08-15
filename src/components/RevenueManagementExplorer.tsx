"use client";

import { Fragment, useMemo, useState } from "react";
import { formatShortDate, formatRelativeTime } from "@/lib/format";
import { useCurrency } from "@/components/CurrencyProvider";
import type { RateSnapshotRow, RateOverrideRow } from "@/lib/revenueManager";

// Revenue Manager tab (Phase 5, promoted out of shadow mode in Phase 5b, then
// given an optional auto-apply band in Phase 5c — see docs/VISION.md). The
// table itself is still a pure comparison — what OwnerRez is actually
// quoting right now, what PriceLabs recommends, what the AI would recommend
// — built up daily so a track record exists before any number gets pushed
// live. Each expanded row has an "Apply this rate" action; clicking it is
// the manual path a rate can move through. Apply pushes a Date Specific
// Override into PriceLabs (see lib/pricelabs.ts's applyDateOverride()),
// which PriceLabs then syncs into OwnerRez on its own schedule — not
// instantly. As of Phase 5c there's a second, OFF-by-default path too: if
// Seni explicitly enables REVENUE_AUTO_APPLY_ENABLED, small in-band pushes
// happen automatically via the daily cron (lib/revenueManager.ts's
// runAutoApplyPass) — those show the blue "🤖 Auto" badge below so it's
// always obvious which override was a click and which was autopilot.

const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  low: "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60",
};

// OwnerRez/PriceLabs rates are always tracked in USD — `format` is passed in
// from the component body (useCurrency() called there) so this stays a
// plain helper rather than needing its own hook call.
function cellText(cents: number | null, format: (amount: number, nativeCurrency?: string) => string): string {
  return cents === null ? "—" : format(cents / 100);
}

function dayOfWeek(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(iso + "T00:00:00Z"));
  } catch {
    return "";
  }
}

/** AI vs. PriceLabs, as a signed percentage difference (positive = AI
 * recommends higher). Null when either side is missing. */
function diffPercent(aiCents: number | null, otherCents: number | null): number | null {
  if (aiCents === null || otherCents === null || otherCents === 0) return null;
  return Math.round(((aiCents - otherCents) / otherCents) * 100);
}

export function RevenueManagementExplorer({
  initialSnapshots,
  initialOverrides,
}: {
  initialSnapshots: RateSnapshotRow[];
  initialOverrides: RateOverrideRow[];
}) {
  const { format } = useCurrency();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<RateOverrideRow[]>(initialOverrides);
  const snapshots = initialSnapshots;

  const overrideByDate = useMemo(() => new Map(overrides.map((o) => [o.stayDate, o])), [overrides]);

  const withRecommendation = useMemo(() => snapshots.filter((s) => s.aiRecommendedRateCents !== null), [snapshots]);
  const avgVsPriceLabs = useMemo(() => {
    const diffs = withRecommendation
      .map((s) => diffPercent(s.aiRecommendedRateCents, s.priceLabsRateCents))
      .filter((d): d is number => d !== null);
    if (diffs.length === 0) return null;
    return Math.round(diffs.reduce((sum, d) => sum + d, 0) / diffs.length);
  }, [withRecommendation]);

  function onApplied(override: RateOverrideRow) {
    setOverrides((prev) => [...prev.filter((o) => o.stayDate !== override.stayDate), override]);
  }

  return (
    <div className="space-y-4">
      <div className="text-sm rounded-md bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-300 px-3 py-2">
        Approval-gated — nothing here ever changes automatically. Expand a date, review or edit the rate, and click
        &ldquo;Apply this rate&rdquo; only when you want it to go live. Applying pushes the price into PriceLabs,
        which syncs it into OwnerRez on its own schedule (not instantly).
      </div>

      {snapshots.length === 0 ? (
        <p className="text-sm text-black/50 dark:text-white/50">
          No snapshots yet — the daily job hasn&rsquo;t run, or hasn&rsquo;t written any data. Check back after the next
          scheduled run.
        </p>
      ) : (
        <>
          <p className="text-xs text-black/40 dark:text-white/40">
            {snapshots.length} upcoming date(s) tracked
            {avgVsPriceLabs !== null && (
              <>
                {" "}
                — on average the AI recommends {avgVsPriceLabs > 0 ? "+" : ""}
                {avgVsPriceLabs}% vs. PriceLabs
              </>
            )}
          </p>

          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
            <table className="w-full text-sm">
              <thead className="bg-black/5 dark:bg-white/5 text-left text-xs uppercase tracking-wide text-black/50 dark:text-white/50">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">OwnerRez (live)</th>
                  <th className="px-3 py-2">PriceLabs</th>
                  <th className="px-3 py-2">AI recommends</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => {
                  const isOpen = expanded === s.stayDate;
                  const vsPriceLabs = diffPercent(s.aiRecommendedRateCents, s.priceLabsRateCents);
                  const override = overrideByDate.get(s.stayDate);
                  return (
                    <Fragment key={s.stayDate}>
                      <tr
                        className="border-t border-black/5 dark:border-white/5 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                        onClick={() => setExpanded(isOpen ? null : s.stayDate)}
                      >
                        <td className="px-3 py-2 whitespace-nowrap">
                          {formatShortDate(s.stayDate)} <span className="text-black/40 dark:text-white/40">{dayOfWeek(s.stayDate)}</span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{cellText(s.ownerRezRateCents, format)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{cellText(s.priceLabsRateCents, format)}</td>
                        <td className="px-3 py-2 whitespace-nowrap font-medium">
                          {cellText(s.aiRecommendedRateCents, format)}
                          {vsPriceLabs !== null && (
                            <span className="ml-1 text-xs font-normal text-black/40 dark:text-white/40">
                              ({vsPriceLabs > 0 ? "+" : ""}
                              {vsPriceLabs}%)
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {s.aiConfidence && (
                            <span
                              className={`inline-block rounded-full px-2 py-0.5 text-xs ${CONFIDENCE_STYLES[s.aiConfidence] ?? ""}`}
                            >
                              {s.aiConfidence}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {override && (
                            <span className="inline-flex items-center gap-1">
                              <span
                                className={`inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${
                                  override.status === "applied"
                                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                                    : "bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300"
                                }`}
                              >
                                {override.status === "applied"
                                  ? `Applied ${format(override.appliedPriceCents / 100)}`
                                  : "Push failed"}
                              </span>
                              {override.triggeredBy === "auto_apply_band" && (
                                <span
                                  className="inline-block rounded-full px-2 py-0.5 text-xs whitespace-nowrap bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300"
                                  title="Pushed automatically by the auto-apply band, not a manual click"
                                >
                                  🤖 Auto
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-black/30 dark:text-white/30 text-xs">{isOpen ? "▲" : "▼"}</td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-black/5 dark:border-white/5 bg-black/[0.015] dark:bg-white/[0.02]">
                          <td colSpan={7} className="px-3 py-3 space-y-3">
                            <div className="text-sm text-black/70 dark:text-white/70">
                              {s.aiReasoning ?? "No reasoning recorded for this date."}
                              <div className="mt-1 text-xs text-black/40 dark:text-white/40">
                                Snapshot last captured {formatShortDate(s.runDate)}.
                              </div>
                            </div>
                            {override && (
                              <div className="text-xs text-black/50 dark:text-white/50">
                                {override.status === "applied" ? "Last applied" : "Last attempt"}:{" "}
                                {format(override.appliedPriceCents / 100)} {formatRelativeTime(override.createdAt)}
                                {override.reason ? ` — ${override.reason}` : ""}
                              </div>
                            )}
                            <ApplyRateControl
                              stayDate={s.stayDate}
                              defaultPriceCents={s.aiRecommendedRateCents ?? s.ownerRezRateCents}
                              onApplied={onApplied}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ApplyRateControl({
  stayDate,
  defaultPriceCents,
  onApplied,
}: {
  stayDate: string;
  defaultPriceCents: number | null;
  onApplied: (override: RateOverrideRow) => void;
}) {
  const { format } = useCurrency();
  const [price, setPrice] = useState(defaultPriceCents !== null ? (defaultPriceCents / 100).toFixed(2) : "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justApplied, setJustApplied] = useState(false);

  const priceNum = Number(price);
  const validPrice = Number.isFinite(priceNum) && priceNum > 0;

  async function confirmApply() {
    if (!validPrice) return;
    setBusy(true);
    setError(null);
    try {
      const priceCents = Math.round(priceNum * 100);
      const res = await fetch("/api/revenue/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stayDate, priceCents }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Push failed.");
      onApplied({
        stayDate,
        appliedPriceCents: priceCents,
        status: "applied",
        createdAt: new Date().toISOString(),
        reason: null,
        triggeredBy: "manual",
      });
      setJustApplied(true);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Push failed.");
    } finally {
      setBusy(false);
    }
  }

  if (justApplied && !confirming) {
    return (
      <p className="text-xs text-emerald-700 dark:text-emerald-300">
        Pushed to PriceLabs. It may take up to PriceLabs&rsquo; normal sync cycle before this shows up live in
        OwnerRez.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-black/50 dark:text-white/50">Rate to push ($/night):</label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={price}
          onChange={(e) => {
            setPrice(e.target.value);
            setConfirming(false);
          }}
          className="w-28 rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2 py-1 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
        />
        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={!validPrice}
            className="text-xs px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
          >
            Apply this rate
          </button>
        ) : (
          <>
            <span className="text-xs text-black/60 dark:text-white/60">
              Push {format(priceNum)} for {formatShortDate(stayDate)} live via PriceLabs?
            </span>
            <button
              onClick={confirmApply}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              {busy ? "Pushing…" : "Confirm & push"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10 disabled:opacity-40"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

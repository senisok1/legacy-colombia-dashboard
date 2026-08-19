"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/LanguageProvider";

// Commissions tab (2026-08-19, Seni's ask) — a shared ledger for Seni and
// Gabriel: extras commission (Team Management's "Add extra") plus Gabriel's
// 10% direct-booking referrals (auto-detected from OwnerRez's `source`
// field containing "gabriel" — see lib/directBookingCommissions.ts).
//
// Everyone reads the same list; only the owner can approve/decline a line
// or settle a payout (server-enforced in api/management/commissions' PUT/
// POST, not just hidden here). Settling records a permanent snapshot — see
// lib/commissionSettlements.ts — rather than silently zeroing a balance.

type ExtraLine = {
  type: "extra";
  id: string;
  bookingId: number;
  guestName: string | null;
  serviceDate: string | null;
  label: string;
  guestPaid: number;
  vendorPaid: number;
  houseAmount: number;
  gabrielAmount: number;
  createdBy: string | null;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  declined: boolean;
  declinedReason: string | null;
};

type DirectLine = {
  type: "direct_booking";
  id: string;
  bookingId: number;
  guestName: string | null;
  arrival: string | null;
  departure: string | null;
  totalAmount: number;
  commissionPct: number;
  houseAmount: number;
  gabrielAmount: number;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  declined: boolean;
  declinedReason: string | null;
};

type Line = ExtraLine | DirectLine;

type Settlement = {
  id: string;
  settledByName: string | null;
  settledAt: string;
  fxRate: number;
  fxBufferPct: number;
  effectiveRate: number;
  totalUsd: number;
  totalCop: number;
  note: string | null;
};

type Rate = { currency: string; usdToTarget: number; source: "live" | "fallback" } | null;

type BoardData = {
  enabled: boolean;
  viewerIsOwner: boolean;
  extras: ExtraLine[];
  directBookings: DirectLine[];
  settlements: Settlement[];
  pendingTotalUsd: number;
  payableTotalUsd: number;
  previewRate: Rate;
};

function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function cop(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} COP`;
}

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function lineTitle(l: Line, t: (key: string) => string): string {
  if (l.type === "extra") {
    return `${l.label} — ${l.guestName || "Guest"}${l.serviceDate ? ` (${when(l.serviceDate)})` : ""}`;
  }
  return `${t("comm.directBooking")} — ${l.guestName || "Guest"}${l.arrival ? ` (${when(l.arrival)})` : ""}`;
}

export function CommissionsBoard() {
  const t = useT();
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showSettle, setShowSettle] = useState(false);
  const [bufferPct, setBufferPct] = useState("0");
  const [note, setNote] = useState("");
  const [settling, setSettling] = useState(false);
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/management/commissions");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json as BoardData);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : t("comm.couldntLoad"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(l: Line, approved: boolean, declined: boolean, declinedReason?: string) {
    setBusyId(l.id);
    try {
      const res = await fetch("/api/management/commissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: l.type, id: l.id, approved, declined, declinedReason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("comm.couldntSave"));
    } finally {
      setBusyId(null);
    }
  }

  function decline(l: Line) {
    const reason = window.prompt(t("comm.declineReasonPrompt"), "");
    if (reason === null) return;
    void decide(l, false, true, reason);
  }

  async function settle() {
    setSettling(true);
    setError(null);
    try {
      const res = await fetch("/api/management/commissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fxBufferPct: Number(bufferPct) || 0, note: note.trim() || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setShowSettle(false);
      setBufferPct("0");
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("comm.couldntSave"));
    } finally {
      setSettling(false);
    }
  }

  if (error && !data) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-black/50 dark:text-white/50">{t("comm.loading")}</p>;
  }
  if (!data.enabled) {
    return (
      <p className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 text-sm text-black/60 dark:text-white/60">
        {t("comm.notEnabled")}
      </p>
    );
  }

  const allLines: Line[] = [...data.extras, ...data.directBookings];
  const pending = allLines.filter((l) => !l.approved && !l.declined);
  const approved = allLines.filter((l) => l.approved && !l.declined);
  const declined = allLines.filter((l) => l.declined);

  const bufferNum = Number(bufferPct) || 0;
  const previewEffectiveRate = data.previewRate ? data.previewRate.usdToTarget * (1 + bufferNum / 100) : null;
  const previewTotalCop = previewEffectiveRate ? data.payableTotalUsd * previewEffectiveRate : null;

  return (
    <div className="space-y-4">
      {!data.viewerIsOwner && (
        <p className="text-xs text-black/50 dark:text-white/50">{t("comm.viewOnlyNote")}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[14rem] rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
          <div className="text-xs text-blue-700 dark:text-blue-400">{t("comm.owedToGabriel")}</div>
          <div className="text-2xl font-semibold">{usd(data.payableTotalUsd)}</div>
        </div>
        <div className="flex-1 min-w-[14rem] rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="text-xs text-amber-700 dark:text-amber-400">{t("comm.awaitingApproval")}</div>
          <div className="text-2xl font-semibold">{usd(data.pendingTotalUsd)}</div>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Pending review */}
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-2">
        <h2 className="text-sm font-semibold">{t("comm.pendingReview")}</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">{t("comm.noPending")}</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-black/[0.03] dark:bg-white/[0.06] px-3 py-2 text-sm"
              >
                <span className="rounded-full bg-black/10 dark:bg-white/10 px-2 py-0.5 text-xs">
                  {l.type === "extra" ? t("comm.extraType") : t("comm.directBooking")}
                </span>
                <span>{lineTitle(l, t)}</span>
                <span className="ml-auto tabular-nums text-xs text-black/50 dark:text-white/50">
                  {t("comm.house")} {usd(l.houseAmount)} · <strong className="text-black dark:text-white">{t("comm.gabriel")} {usd(l.gabrielAmount)}</strong>
                </span>
                {data.viewerIsOwner && (
                  <span className="flex gap-1.5">
                    <button
                      onClick={() => void decide(l, true, false)}
                      disabled={busyId === l.id}
                      className="rounded-md bg-[var(--accent)] px-2 py-1 text-xs text-white disabled:opacity-40"
                    >
                      {t("comm.approve")}
                    </button>
                    <button
                      onClick={() => decline(l)}
                      disabled={busyId === l.id}
                      className="rounded-md border border-black/15 dark:border-white/15 px-2 py-1 text-xs disabled:opacity-40"
                    >
                      {t("comm.decline")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Approved / payable */}
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("comm.approvedLocked")}</h2>
          {data.viewerIsOwner && approved.length > 0 && (
            <button
              onClick={() => setShowSettle(true)}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white"
            >
              {t("comm.settlePayout")}
            </button>
          )}
        </div>
        {approved.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">{t("comm.noApproved")}</p>
        ) : (
          <ul className="space-y-1">
            {approved.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-blue-500/5 px-3 py-2 text-sm"
              >
                <span className="rounded-full bg-black/10 dark:bg-white/10 px-2 py-0.5 text-xs">
                  {l.type === "extra" ? t("comm.extraType") : t("comm.directBooking")}
                </span>
                <span>{lineTitle(l, t)}</span>
                <span className="ml-auto tabular-nums text-xs">
                  {t("comm.house")} {usd(l.houseAmount)} · <strong>{t("comm.gabriel")} {usd(l.gabrielAmount)}</strong>
                </span>
                <span className="text-xs text-blue-600 dark:text-blue-400">🔒</span>
              </li>
            ))}
          </ul>
        )}
        {declined.length > 0 && (
          <details className="text-xs text-black/50 dark:text-white/50">
            <summary className="cursor-pointer">{t("comm.declinedLine")} ({declined.length})</summary>
            <ul className="mt-1 space-y-1">
              {declined.map((l) => (
                <li key={l.id}>
                  {lineTitle(l, t)} {l.declinedReason ? `— ${l.declinedReason}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* Settlement history */}
      <section className="rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-2">
        <h2 className="text-sm font-semibold">{t("comm.settlementHistory")}</h2>
        {data.settlements.length === 0 ? (
          <p className="text-sm text-black/50 dark:text-white/50">{t("comm.noSettlements")}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.settlements.map((s) => (
              <li key={s.id} className="rounded-lg bg-black/[0.03] dark:bg-white/[0.06] px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="font-semibold">{usd(s.totalUsd)} → {cop(s.totalCop)}</span>
                  <span className="text-xs text-black/50 dark:text-white/50">
                    {t("comm.settledBy")} {s.settledByName || "—"} · {when(s.settledAt)}
                  </span>
                </div>
                <div className="text-xs text-black/40 dark:text-white/40">
                  {t("comm.effectiveRate")}: {s.effectiveRate.toLocaleString("en-US", { maximumFractionDigits: 2 })} (
                  {t("comm.liveRate")} {s.fxRate.toLocaleString("en-US", { maximumFractionDigits: 2 })} + {s.fxBufferPct}%
                  {t("comm.buffer").toLowerCase()})
                  {s.note ? ` — ${s.note}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showSettle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !settling && setShowSettle(false)}>
          <div
            className="w-full max-w-md rounded-xl bg-white dark:bg-neutral-900 p-5 space-y-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold">{t("comm.settleTitle")}</h3>
            <p className="text-xs text-black/50 dark:text-white/50">{t("comm.settleHelp")}</p>

            <div className="text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-black/50 dark:text-white/50">{t("comm.owedToGabriel")}</span>
                <span className="font-medium tabular-nums">{usd(data.payableTotalUsd)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-black/50 dark:text-white/50">{t("comm.liveRate")}</span>
                <span className="tabular-nums">
                  {data.previewRate ? `1 USD ≈ ${data.previewRate.usdToTarget.toLocaleString("en-US", { maximumFractionDigits: 2 })} COP` : "—"}
                </span>
              </div>
              <label className="flex items-center justify-between gap-2">
                <span className="text-black/50 dark:text-white/50">{t("comm.buffer")}</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="50"
                  value={bufferPct}
                  onChange={(e) => setBufferPct(e.target.value)}
                  className="w-20 rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1 text-right text-sm"
                />
              </label>
              <div className="flex justify-between">
                <span className="text-black/50 dark:text-white/50">{t("comm.effectiveRate")}</span>
                <span className="tabular-nums">
                  {previewEffectiveRate ? previewEffectiveRate.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}
                </span>
              </div>
              <div className="flex justify-between border-t border-black/10 dark:border-white/10 pt-1 font-semibold">
                <span>{t("comm.totalCop")}</span>
                <span className="tabular-nums">{previewTotalCop !== null ? cop(previewTotalCop) : "—"}</span>
              </div>
            </div>

            <label className="block text-xs text-black/60 dark:text-white/60">
              {t("comm.noteOptional")}
              <input
                className="mt-0.5 block w-full rounded-md border border-black/15 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowSettle(false)}
                disabled={settling}
                className="rounded-md border border-black/15 dark:border-white/15 px-3 py-1.5 text-sm disabled:opacity-40"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => void settle()}
                disabled={settling}
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
              >
                {settling ? t("comm.settling") : t("comm.confirmSettle")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
